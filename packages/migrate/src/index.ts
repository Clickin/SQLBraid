import type { Database } from "@sqlbraid/core";
import {
  bootstrapHistory,
  createMigrationSql,
  isClaimConflict,
  isMigrationBusy,
  transactionalDdl,
  withMigrationLock,
} from "./dialect.js";
import { MigrationError, MigrationStartupError } from "./errors.js";
import { compareHistory, createHistoryStore } from "./history.js";
import { compareVersions, isMigrationBody, normalizeVersion } from "./manifest.js";
import { splitMigrationSql } from "./split.js";
import type {
  DefineMigrationOptions,
  DialectManifest,
  ManifestEntry,
  MigrationBody,
  MigrationDefinition,
  MigrationEvent,
  MigrationHistoryRow,
  MigrationReport,
  Migrator,
  MigratorOptions,
  OnceOptions,
  StartupOptions,
} from "./types.js";

export { MigrationError, MigrationStartupError } from "./errors.js";
export type * from "./types.js";

/** Declare a TypeScript migration. The runner passes it a scoped database handle. */
export function defineMigration(
  migration: (db: Database) => Promise<void>,
  options: DefineMigrationOptions = {},
): MigrationDefinition {
  if (typeof migration !== "function") throw new TypeError("A migration must be an async function.");
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Migration options must be an object.");
  const unknown = Object.keys(options).filter((key) => key !== "transaction");
  if (unknown.length) throw new TypeError(`Unknown migration options: ${unknown.join(", ")}.`);
  if (options.transaction !== undefined && typeof options.transaction !== "boolean")
    throw new TypeError("Migration option transaction must be a boolean.");
  return Object.freeze({ run: migration, transaction: options.transaction ?? true });
}

class MigrationClaimError extends Error {
  constructor(
    readonly busy: boolean,
    cause: unknown,
  ) {
    super("Another runner holds the migration history claim.", { cause });
  }
}

function text(value: unknown, name: string, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || value.includes("\0")) {
    throw new TypeError(`${name} must be a nonempty string of at most ${limit} characters without NUL.`);
  }
}

function interval(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a nonnegative integer no greater than 2147483647.`);
  }
}

function checksum(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) {
    throw new MigrationError(
      "BRAID_MIGRATE_SOURCE",
      "Migration checksums and manifest hashes must be SHA-256 hex strings.",
    );
  }
}

function validateManifest(options: MigratorOptions): DialectManifest {
  const manifest = options.manifest;
  if (
    !manifest ||
    manifest.format !== "sqlbraid-migrations" ||
    manifest.formatVersion !== 1 ||
    !manifest.dialects ||
    typeof manifest.dialects !== "object"
  ) {
    throw new MigrationError("BRAID_MIGRATE_SOURCE", "Expected a sqlbraid-migrations formatVersion 1 manifest.");
  }
  const selected = Object.hasOwn(manifest.dialects, options.dialect.id)
    ? manifest.dialects[options.dialect.id]
    : undefined;
  if (!selected || !Array.isArray(selected.versioned) || !Array.isArray(selected.repeatable)) {
    throw new MigrationError("BRAID_MIGRATE_SOURCE", `No migration sources for dialect ${options.dialect.id}.`);
  }
  checksum(selected.hash);
  const versions = new Set<string>();
  const sources = new Set<string>();
  const validate = (entry: ManifestEntry, repeatable: boolean): ManifestEntry => {
    if (!entry || typeof entry !== "object" || typeof entry.load !== "function") {
      throw new MigrationError("BRAID_MIGRATE_SOURCE", "Each manifest entry must have a loader.");
    }
    text(entry.description, "Migration description", 200);
    text(entry.source, "Migration source", 1000);
    checksum(entry.checksum);
    if (sources.has(entry.source))
      throw new MigrationError("BRAID_MIGRATE_SOURCE", `Duplicate migration source ${entry.source}.`);
    sources.add(entry.source);
    if (repeatable) {
      if (entry.version !== null) throw new MigrationError("BRAID_MIGRATE_SOURCE", "Repeatable versions must be null.");
    } else {
      text(entry.version, "Migration version", 50);
      if (!/^\d+(?:[._]\d+)*$/.test(entry.version))
        throw new MigrationError("BRAID_MIGRATE_SOURCE", `Invalid migration version ${entry.version}.`);
      const version = normalizeVersion(entry.version);
      if (versions.has(version))
        throw new MigrationError("BRAID_MIGRATE_SOURCE", `Duplicate migration version ${entry.version}.`);
      versions.add(version);
    }
    return Object.freeze({ ...entry, checksum: entry.checksum.toLowerCase() });
  };
  return Object.freeze({
    hash: selected.hash.toLowerCase(),
    // oxlint-disable-next-line no-array-sort -- Sort the newly owned validated array, never the caller's manifest.
    versioned: Object.freeze(
      selected.versioned.map((entry) => validate(entry, false)).sort((a, b) => compareVersions(a.version!, b.version!)),
    ),
    // oxlint-disable-next-line no-array-sort -- Source order is deterministic and the array is newly owned.
    repeatable: Object.freeze(
      selected.repeatable
        .map((entry) => validate(entry, true))
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
    ),
  });
}

function validateStartup(options: StartupOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("Startup options must be an object.");
  if (options.mode !== undefined && !["off", "report", "verify", "apply"].includes(options.mode))
    throw new TypeError("Invalid migration startup mode.");
  if (options.ahead !== undefined && options.ahead !== "allow" && options.ahead !== "error")
    throw new TypeError("Invalid ahead policy.");
  if (options.schema !== undefined && options.schema !== "hash") throw new TypeError("Invalid schema check mode.");
  if (options.onReport !== undefined && typeof options.onReport !== "function")
    throw new TypeError("onReport must be a function.");
}

async function commitHistory(db: Database, write: (target: Database) => Promise<void>): Promise<void> {
  if ((await db.environment()).capabilities.transaction?.status === "guaranteed") await db.tx(write);
  else await write(db);
}

export function createMigrator(options: MigratorOptions): Migrator {
  if (!options || typeof options !== "object") throw new TypeError("Migrator options must be an object.");
  if (!options.dialect || typeof options.dialect.quoteIdentifier !== "function")
    throw new TypeError("An explicit SQLBraid dialect is required.");
  text(options.dialect.id, "Dialect id", 32);
  const { dialect, drift, onEvent } = options;
  const scope = options.scope === undefined ? "default" : options.scope;
  const table = options.table === undefined ? "_sqlbraid_migrations" : options.table;
  const schema = options.schema;
  const appliedBy = options.appliedBy === undefined ? "sqlbraid" : options.appliedBy;
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 30_000 : options.busyTimeoutMs;
  text(scope, "Migration scope", 64);
  text(table, "History table", 128);
  if (schema !== undefined) text(schema, "History schema", 128);
  text(appliedBy, "appliedBy", 128);
  interval(busyTimeoutMs, "busyTimeoutMs");
  if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("onEvent must be a function.");
  if (
    drift !== undefined &&
    (!drift || typeof drift.inspect !== "function" || (drift.dialect !== undefined && drift.dialect !== dialect.id))
  ) {
    throw new TypeError("drift must provide inspect() for the selected dialect.");
  }
  const manifest = validateManifest(options);
  const store = createHistoryStore(dialect, scope, table, schema);
  const sql = createMigrationSql(dialect);
  const onceChecks = new WeakMap<Database, Map<string, { promise: Promise<MigrationReport>; failedAt?: number }>>();
  const emit = (event: MigrationEvent): void => {
    onEvent?.(Object.freeze(event));
  };
  const lockOptions = {
    scope,
    table,
    ...(schema === undefined ? {} : { schema }),
    busyTimeoutMs,
    onAcquire: () => emit({ type: "lock.acquire", scope }),
    onRelease: () => emit({ type: "lock.release", scope }),
  };

  async function inspectSchema() {
    if (!drift) throw new TypeError("Schema inspection requires the drift option.");
    const inspection = await drift.inspect();
    checksum(inspection.hash);
    return inspection;
  }

  async function report(db: Database, checkSchema: boolean): Promise<MigrationReport> {
    let result = compareHistory(manifest, await store.read(db), scope, dialect.id);
    if (checkSchema) {
      const inspection = await inspectSchema();
      let previous: string | null = null;
      for (let index = result.history.length - 1; index >= 0; index -= 1) {
        const hash = result.history[index].schema_hash;
        if (hash !== null) {
          previous = hash;
          break;
        }
      }
      if (previous !== undefined && previous !== null && previous !== inspection.hash) {
        const paths = inspection.differences?.length ? inspection.differences : ["$"];
        result = {
          ...result,
          status: result.status === "incomplete" || result.status === "uninitialized" ? result.status : "mismatch",
          summary: `Migration scope ${scope} has schema drift.`,
          differences: [
            ...result.differences,
            ...paths.map((path) => ({
              kind: "schema-drift" as const,
              path,
              expected: previous,
              actual: inspection.hash,
            })),
          ],
        };
      }
    }
    return Object.freeze({
      ...result,
      differences: Object.freeze(result.differences.map((difference) => Object.freeze(difference))),
      history: Object.freeze(result.history.map((row) => Object.freeze(row))),
    });
  }

  async function apply(db: Database): Promise<void> {
    const executionId =
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`.slice(
        0,
        36,
      );
    let lastApplied: MigrationHistoryRow | undefined;
    await withMigrationLock(db, dialect, lockOptions, async (locked) => {
      const environment = await locked.environment();
      const canTransact = transactionalDdl(dialect, environment);
      let rows = await store.read(locked);
      if (rows === undefined) {
        await bootstrapHistory(locked, dialect, table, schema);
        rows = await store.read(locked);
      }
      let waitingSince: number | undefined;
      const waitForClaim = async (): Promise<void> => {
        waitingSince ??= Date.now();
        const remaining = busyTimeoutMs - (Date.now() - waitingSince);
        if (remaining <= 0)
          throw new MigrationError(
            "BRAID_MIGRATE_BUSY",
            `Migration scope ${scope} is busy; inspect running attempts before repair.`,
          );
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
      };
      for (;;) {
        const current = compareHistory(manifest, rows, scope, dialect.id);
        if (current.history.some((row) => row.status === "failed")) throw new MigrationStartupError(current);
        if (current.history.some((row) => row.status === "running")) {
          await waitForClaim();
          rows = await store.read(locked);
          continue;
        }
        if (current.status === "mismatch" || current.status === "uninitialized")
          throw new MigrationStartupError(current);
        const pending = current.differences.find(
          (difference) => difference.kind === "pending" || difference.kind === "repeatable-changed",
        );
        if (!pending) break;
        const entry =
          pending.kind === "pending"
            ? manifest.versioned.find((candidate) => candidate.source === pending.source)!
            : manifest.repeatable.find((candidate) => candidate.source === pending.source)!;
        const body: MigrationBody = await entry.load();
        if (!isMigrationBody(body))
          throw new MigrationError("BRAID_MIGRATE_SOURCE", `Invalid migration body in ${entry.source}.`);
        const split = typeof body === "string" ? splitMigrationSql(body, dialect) : undefined;
        const definition = typeof body === "object" ? body : undefined;
        const rank = (current.history[current.history.length - 1]?.installed_rank ?? 0) + 1;
        const row: MigrationHistoryRow = {
          scope,
          installed_rank: rank,
          version: entry.version,
          kind: entry.version === null ? "repeatable" : "versioned",
          description: entry.description,
          source: entry.source,
          dialect: dialect.id,
          checksum: entry.checksum,
          status: "running",
          execution_id: executionId,
          applied_by: appliedBy,
          started_at: new Date().toISOString(),
          duration_ms: null,
          schema_hash: null,
        };
        let claimed = false;
        let durationMs = 0;
        const started = Date.now();
        const claim = async (target: Database): Promise<void> => {
          try {
            await store.insert(target, row);
          } catch (error) {
            if (isClaimConflict(error, dialect)) throw new MigrationClaimError(false, error);
            if (isMigrationBusy(error, dialect)) throw new MigrationClaimError(true, error);
            throw error;
          }
        };
        const transactional = canTransact && (split?.transaction ?? definition?.transaction ?? true);
        const run = async (target: Database): Promise<void> => {
          // Nontransactional bodies must not run until the history claim is committed.
          if (transactional) await claim(target);
          else await commitHistory(target, claim);
          claimed = true;
          emit({ type: "migration.start", entry });
          if (typeof body === "function") await body(target);
          else if (definition) await definition.run(target);
          else
            for (const statement of split!.statements)
              await target.execute(sql`${sql.raw(statement)}`, { reuse: "simple" });
          durationMs = Math.max(0, Date.now() - started);
          if (transactional) await store.finish(target, rank, executionId, "success", durationMs);
          else
            await commitHistory(target, (history) => store.finish(history, rank, executionId, "success", durationMs));
        };
        try {
          if (transactional) await locked.tx(run);
          else await run(locked);
        } catch (error) {
          if (error instanceof MigrationClaimError || (!claimed && isMigrationBusy(error, dialect))) {
            if (!(error instanceof MigrationClaimError) || error.busy) await waitForClaim();
            rows = await store.read(locked);
            continue;
          }
          const failures = [error];
          if (claimed && !transactional) {
            try {
              await commitHistory(locked, (history) =>
                store.finish(history, rank, executionId, "failed", Math.max(0, Date.now() - started)),
              );
            } catch (finishError) {
              failures.push(finishError);
            }
          }
          if (claimed) {
            try {
              emit({ type: "migration.error", entry, error });
            } catch (eventError) {
              failures.push(eventError);
            }
          }
          if (failures.length > 1)
            throw new AggregateError(
              failures,
              `Migration ${entry.source} failed, including cleanup or event reporting.`,
              { cause: error },
            );
          throw error;
        }
        lastApplied = row;
        waitingSince = undefined;
        emit({ type: "migration.end", entry, durationMs });
        rows = await store.read(locked);
      }
    });
    if (drift && lastApplied) {
      const inspection = await inspectSchema();
      const applied = lastApplied;
      await commitHistory(db, (history) =>
        store.schemaHash(history, applied.installed_rank, applied.execution_id, inspection.hash),
      );
    }
  }

  async function startup(db: Database, startupOptions: StartupOptions = {}): Promise<MigrationReport> {
    validateStartup(startupOptions);
    const mode = startupOptions.mode ?? "verify";
    if (mode === "off") {
      return Object.freeze({
        status: "off",
        summary: `Migration scope ${scope} is off.`,
        scope,
        dialect: dialect.id,
        manifestHash: manifest.hash,
        head: null,
        differences: [],
        history: [],
      });
    }
    if (startupOptions.schema === "hash" && !drift) throw new TypeError("schema: 'hash' requires the drift option.");
    const publish = (result: MigrationReport): void => {
      startupOptions.onReport?.(result);
      emit({ type: "startup.check", report: result });
    };
    if (mode === "apply") {
      if (startupOptions.schema === "hash") {
        // Applying records a new hash, so existing drift must fail before any migration runs.
        const before = await report(db, true);
        if (before.differences.some((difference) => difference.kind === "schema-drift")) {
          publish(before);
          throw new MigrationStartupError(before);
        }
      }
      await apply(db);
    }
    const result = await report(db, startupOptions.schema === "hash");
    publish(result);
    if (
      (mode === "verify" || mode === "apply") &&
      result.status !== "current" &&
      !(result.status === "ahead" && startupOptions.ahead !== "error")
    ) {
      throw new MigrationStartupError(result);
    }
    return result;
  }

  return {
    startup,
    once(db: Database, onceOptions: OnceOptions = {}): Promise<MigrationReport> {
      validateStartup(onceOptions);
      const retryIntervalMs = onceOptions.retryIntervalMs ?? 1000;
      interval(retryIntervalMs, "retryIntervalMs");
      const key = `${onceOptions.mode ?? "verify"}:${onceOptions.ahead ?? "allow"}:${onceOptions.schema ?? ""}`;
      let checks = onceChecks.get(db);
      if (!checks) {
        checks = new Map();
        onceChecks.set(db, checks);
      }
      const previous = checks.get(key);
      if (previous && (previous.failedAt === undefined || Date.now() - previous.failedAt < retryIntervalMs))
        return previous.promise;
      const check: { promise: Promise<MigrationReport>; failedAt?: number } = { promise: startup(db, onceOptions) };
      check.promise = check.promise.catch((error: unknown) => {
        check.failedAt = Date.now();
        throw error;
      });
      checks.set(key, check);
      return check.promise;
    },
    up: (db) => startup(db, { mode: "apply" }),
    async baseline(db, version) {
      text(version, "Baseline version", 50);
      const entry = manifest.versioned.find((candidate) => compareVersions(candidate.version!, version) === 0);
      if (!entry) throw new MigrationError("BRAID_MIGRATE_SOURCE", `No migration source for baseline ${version}.`);
      const executionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await withMigrationLock(db, dialect, lockOptions, async (locked) => {
        let rows = await store.read(locked);
        if (rows === undefined) {
          await bootstrapHistory(locked, dialect, table, schema);
          rows = await store.read(locked);
        }
        if (rows?.length)
          throw new MigrationError("BRAID_MIGRATE_ORDER", "Baseline requires an empty migration scope.");
        await commitHistory(locked, (history) =>
          store.insert(history, {
            scope,
            installed_rank: 1,
            version: entry.version,
            kind: "baseline",
            description: entry.description,
            source: entry.source,
            dialect: dialect.id,
            checksum: entry.checksum,
            status: "success",
            execution_id: executionId,
            applied_by: appliedBy,
            started_at: new Date().toISOString(),
            duration_ms: 0,
            schema_hash: null,
          }),
        );
      });
      if (drift) {
        const inspection = await inspectSchema();
        await commitHistory(db, (history) => store.schemaHash(history, 1, executionId, inspection.hash));
      }
      return startup(db, { mode: "report" });
    },
    async repair(db) {
      await withMigrationLock(db, dialect, lockOptions, async (locked) => {
        if ((await store.read(locked)) !== undefined) await commitHistory(locked, (history) => store.repair(history));
      });
      return startup(db, { mode: "report" });
    },
    async acceptSchema(db) {
      if (!drift) throw new TypeError("acceptSchema requires the drift option.");
      await withMigrationLock(db, dialect, lockOptions, async (locked) => {
        const current = compareHistory(manifest, await store.read(locked), scope, dialect.id);
        if (current.status === "uninitialized" || current.status === "incomplete")
          throw new MigrationStartupError(current);
        let target: MigrationHistoryRow | undefined;
        for (const row of current.history) if (row.status === "success") target = row;
        if (!target)
          throw new MigrationError(
            "BRAID_MIGRATE_ORDER",
            `Migration scope ${scope} has no successful migration to record a schema hash on.`,
          );
        const inspection = await inspectSchema();
        await commitHistory(locked, (history) =>
          store.schemaHash(history, target.installed_rank, target.execution_id, inspection.hash),
        );
      });
      return startup(db, { mode: "report", schema: "hash" });
    },
    async snapshot(_db) {
      return (await inspectSchema()).snapshot;
    },
  };
}
