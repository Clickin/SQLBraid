import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { test, vi } from "vitest";
import { createLogger, createServer } from "vite";
import type { Plugin } from "vite";
import { createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { dialect } from "@sqlbraid/sqlite";
import {
  compareVersions,
  generateManifestModule,
  loadMigrations,
  normalizeSource,
  normalizeVersion,
} from "../packages/migrate/src/node.js";
import type { MigrationManifest } from "../packages/migrate/src/types.js";
import migrations from "../packages/migrate/src/vite.js";

async function directory(files: Readonly<Record<string, string>>): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sqlbraid-migrations-"));
  for (const [file, source] of Object.entries(files)) await writeFile(join(path, file), source);
  return path;
}

test("numeric migration identities compare arbitrary precision, dotted components and zero aliases", () => {
  assert.equal(normalizeVersion("0001_002.000"), "1.2");
  assert.equal(compareVersions("001", "1.0"), 0);
  assert.equal(compareVersions("1.10", "1.2"), 1);
  assert.equal(compareVersions("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareVersions("1.9007199254740992", "1.9007199254740993"), -1);
  assert.throws(() => compareVersions("1a", "2"), { code: "BRAID_MIGRATE_SOURCE" });
});

test("sources normalize only leading BOM and CRLF before hashing and loading", async () => {
  const text = "\uFEFFSELECT 1;\r\n  \r\n";
  const path = await directory({ "V001__first.sql": text, "R__view.sql": "CREATE VIEW v AS SELECT 1;" });
  try {
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    const entry = manifest.dialects.sqlite!.versioned[0]!;
    assert.equal(await entry.load(), "SELECT 1;\n  \n");
    assert.equal(entry.checksum, createHash("sha256").update("SELECT 1;\n  \n").digest("hex"));
    assert.equal(normalizeSource(" \uFEFFa\rb \n"), " \uFEFFa\rb \n");
    const unchanged = await loadMigrations(path, { dialects: ["sqlite"] });
    assert.equal(unchanged.dialects.sqlite!.hash, manifest.dialects.sqlite!.hash);
    await writeFile(join(path, "V001__first.sql"), "SELECT 1;\n \n");
    const changed = await loadMigrations(path, { dialects: ["sqlite"] });
    assert.notEqual(changed.dialects.sqlite!.hash, manifest.dialects.sqlite!.hash);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("each version and repeatable selects its exact dialect before generic fallback", async () => {
  const path = await directory({
    "V1.10__later.sql": "generic later",
    "V1.2__earlier.sql": "generic earlier",
    "V1.2__earlier.postgres.sql": "postgres earlier",
    "R__view.sql": "generic view",
    "R__view.postgres.sql": "postgres view",
  });
  try {
    const manifest = await loadMigrations(path);
    assert.deepEqual(
      manifest.dialects.postgres!.versioned.map((entry) => entry.version),
      ["1.2", "1.10"],
    );
    assert.equal(await manifest.dialects.postgres!.versioned[0]!.load(), "postgres earlier");
    assert.equal(await manifest.dialects.sqlite!.versioned[0]!.load(), "generic earlier");
    assert.equal(await manifest.dialects.postgres!.repeatable[0]!.load(), "postgres view");
    assert.equal(await manifest.dialects.sqlite!.repeatable[0]!.load(), "generic view");
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("missing variants fail when that target resolves, never silently skip a migration", async () => {
  for (const file of ["V1__only.postgres.sql", "R__only.postgres.sql"]) {
    const path = await directory({ [file]: "" });
    try {
      const manifest = await loadMigrations(path);
      assert.equal(manifest.dialects.postgres!.versioned.length + manifest.dialects.postgres!.repeatable.length, 1);
      assert.throws(() => manifest.dialects.sqlite, { code: "BRAID_MIGRATE_SOURCE" });
      await assert.rejects(loadMigrations(path, { dialects: ["sqlite"] }), { code: "BRAID_MIGRATE_SOURCE" });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
});

test("dialect suffixes must be supported dialect ids; descriptions must not contain dots", async () => {
  for (const file of ["V3__add.users.email.sql", "V3__add.users.postgres.sql", "R__view.custom.sql"]) {
    const path = await directory({ [file]: "SELECT 1;" });
    try {
      await assert.rejects(loadMigrations(path), (error: Error & { code?: string }) => {
        assert.equal(error.code, "BRAID_MIGRATE_SOURCE");
        assert.match(error.message, /must not contain dots/u);
        return true;
      });
      await assert.rejects(generateManifestModule(path), { code: "BRAID_MIGRATE_SOURCE" });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
});

test("symbolic links to migration files and directories are followed, never skipped", async () => {
  const shared = await directory({ "V2__shared.sql": "CREATE TABLE shared (id INTEGER);" });
  const path = await directory({ "target.sql": "CREATE TABLE linked (id INTEGER);" });
  try {
    await symlink(join(path, "target.sql"), join(path, "V1__linked.sql"));
    await symlink(shared, join(path, "nested"), "dir");
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    assert.deepEqual(
      manifest.dialects.sqlite!.versioned.map((entry) => entry.source),
      ["V1__linked.sql", "nested/V2__shared.sql"],
    );
    assert.match(String(await manifest.dialects.sqlite!.versioned[0]!.load()), /linked/u);
    await symlink(path, join(path, "loop"), "dir");
    await assert.rejects(loadMigrations(path), { code: "BRAID_MIGRATE_SOURCE" });
    await rm(join(path, "loop"));
    await symlink(join(path, "absent.sql"), join(path, "V3__broken.sql"));
    await assert.rejects(loadMigrations(path), { code: "BRAID_MIGRATE_SOURCE" });
  } finally {
    await rm(path, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
});

test("version variants may describe an explicit dialect-specific no-op differently", async () => {
  const path = await directory({ "V007__create_index.sql": "CREATE INDEX i ON t(id);", "V007__noop.sqlite.sql": "" });
  try {
    const manifest = await loadMigrations(path, { dialects: ["postgres", "sqlite"] });
    assert.equal(manifest.dialects.postgres!.versioned[0]!.description, "create_index");
    assert.equal(manifest.dialects.sqlite!.versioned[0]!.description, "noop");
    assert.equal(await manifest.dialects.sqlite!.versioned[0]!.load(), "");
    assert.equal(manifest.dialects.postgres!.versioned[0]!.version, manifest.dialects.sqlite!.versioned[0]!.version);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("duplicate canonical versions and SQL/TS variants are rejected", async () => {
  const cases: Readonly<Record<string, string>>[] = [
    { "V001__first.sql": "", "V1.0__first.sql": "" },
    { "V1__first.sql": "", "V1__first.ts": "export default async () => {}" },
    { "R__view.sql": "", "R__view.ts": "export default async () => {}" },
  ];
  for (const files of cases) {
    const path = await directory(files);
    try {
      await assert.rejects(loadMigrations(path), { code: "BRAID_MIGRATE_SOURCE" });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
});

test("Node TS loading erases types, bundles relative helpers and stays lazy", async () => {
  const path = await directory({
    "V1__typescript.ts":
      'import { value } from "./helper.ts"; export default async (db: { values: number[] }): Promise<void> => { db.values.push(value); };',
    "helper.ts": "export const value: number = 42;",
  });
  try {
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    const body = await manifest.dialects.sqlite!.versioned[0]!.load();
    assert.equal(typeof body, "function");
    const values: number[] = [];
    if (typeof body !== "function") throw new Error("Expected TypeScript migration");
    await Reflect.apply(body, undefined, [{ values }]);
    assert.deepEqual(values, [42]);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("Node TS loading resolves ESM-only dependencies without require hooks", async () => {
  const path = await directory({
    "V1__esm.ts":
      'import value from "migration-esm"; export default async (db: { values: number[] }) => { db.values.push(value); };',
  });
  try {
    const dependency = join(path, "node_modules", "migration-esm");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ type: "module", exports: { import: "./index.js" } }),
    );
    await writeFile(join(dependency, "index.js"), "export default 7;");
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    const body = await manifest.dialects.sqlite!.versioned[0]!.load();
    assert.equal(typeof body, "function");
    const values: number[] = [];
    if (typeof body !== "function") throw new Error("Expected TypeScript migration");
    await Reflect.apply(body, undefined, [{ values }]);
    assert.deepEqual(values, [7]);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("Node rejects guarded TS while generated ESM lowers it through the compiler", async () => {
  const path = await mkdtemp(join(process.cwd(), ".migration-guard-"));
  await writeFile(
    join(path, "V1__guard.ts"),
    'import { sql } from "@sqlbraid/sqlite"; export default async (db: { execute(query: unknown): Promise<void> }) => { await db.execute(sql.command`UPDATE t SET a=1 /*@braid if ${false}*/ WHERE a=${(() => { throw new Error("inactive branch"); })()} /*@braid end*/`); };',
  );
  const native = new DatabaseSync(":memory:");
  try {
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    await assert.rejects(
      manifest.dialects.sqlite!.versioned[0]!.load(),
      (error: unknown) => error instanceof Error && /Guarded SQL directives.*ordinary tags only/su.test(error.message),
    );
    const generated = await generateManifestModule(path, { dialects: ["sqlite"] });
    const output = join(path, "manifest.mjs");
    await writeFile(output, generated);
    // The generated module path exists only for this test run.
    const module: { default: MigrationManifest } = await import(pathToFileURL(output).href);
    const body = await module.default.dialects.sqlite!.versioned[0]!.load();
    if (typeof body !== "function") throw new Error("Expected generated migration function");
    native.exec("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (2), (3);");
    await body(createNodeSqliteDatabase(native));
    assert.deepEqual(
      native
        .prepare("SELECT a FROM t ORDER BY rowid")
        .all()
        .map((row) => row.a),
      [1, 1],
    );
  } finally {
    native.close();
    await rm(path, { recursive: true, force: true });
  }
});

test("generated manifest without a dialect list accepts dialect-only versions", async () => {
  const path = await directory({ "V1__init.postgres.sql": "CREATE TABLE t (id integer);" });
  try {
    const generated = await generateManifestModule(path);
    const module: { default: MigrationManifest } = await import(
      `data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`
    );
    assert.deepEqual(Object.keys(module.default.dialects), ["postgres"]);
    const postgres = module.default.dialects.postgres!;
    assert.equal(postgres.versioned.length, 1);
    assert.equal(await postgres.versioned[0]!.load(), "CREATE TABLE t (id integer);");
    await assert.rejects(generateManifestModule(path, { dialects: ["mysql"] }), /No mysql or generic source/u);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("generated bundled ESM has executable SQL and TS loaders with original source identities", async () => {
  const path = await directory({
    "V1__sql.sql": "SELECT 1;\r\n",
    "V2__ts.ts": "export default async (db: { values: string[] }) => { db.values.push('ran'); };",
  });
  try {
    const expected = await loadMigrations(path, { dialects: ["sqlite"] });
    const generated = await generateManifestModule(path, { dialects: ["sqlite"] });
    const module: { default: MigrationManifest } = await import(
      `data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`
    );
    const manifest = module.default;
    assert.equal(manifest.dialects.sqlite!.hash, expected.dialects.sqlite!.hash);
    assert.equal(await manifest.dialects.sqlite!.versioned[0]!.load(), "SELECT 1;\n");
    const body = await manifest.dialects.sqlite!.versioned[1]!.load();
    assert.equal(typeof body, "function");
    const values: string[] = [];
    if (typeof body !== "function") throw new Error("Expected TypeScript migration");
    await Reflect.apply(body, undefined, [{ values }]);
    assert.deepEqual(values, ["ran"]);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("Vite virtual migration module rejects browser imports and serves bundled SSR manifests", async () => {
  const path = await directory({ "V1__first.sql": "SELECT 1;" });
  try {
    const plugin = migrations({ directory: path, dialects: ["sqlite"] });
    const load = plugin.load;
    assert.equal(typeof load, "function");
    if (typeof load !== "function") throw new Error("Missing load hook");
    const context = {
      addWatchFile() {},
      error(message: string): never {
        throw new Error(message);
      },
    };
    await assert.rejects(
      Promise.resolve(load.call(context as never, "\0virtual:sqlbraid-migrations", { ssr: false })),
      /server-only/u,
    );
    const code = await load.call(context as never, "\0virtual:sqlbraid-migrations", { ssr: true });
    assert.equal(typeof code, "string");
    assert.ok(String(code).includes("sqlbraid-migrations"));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("Vite dev checks report at startup and source changes to terminal and overlay without writes", async () => {
  const path = await directory({ "V1__first.sql": "CREATE TABLE untouched(id INTEGER);" });
  const statements: string[] = [];
  const messages: unknown[] = [];
  const terminal: string[] = [];
  const db = createDatabase({
    statementBinding: {
      id: "migration-vite-test",
      describe(statement, context) {
        return createStatementBindingDescription(statement, context, {
          adapterId: "migration-vite-test",
          transport: "text-positional",
          placeholder: () => "?",
          reuse: { effective: "simple", owner: "sqlbraid" },
        });
      },
    },
    async query(statement) {
      statements.push(statement.segments.join("?"));
      return { kind: "rows", rows: [] };
    },
    async *stream<Row>(): AsyncGenerator<Row> {
      throw new Error("unused");
    },
    async call() {
      throw new Error("unused");
    },
    async begin() {
      throw new Error("Dev check must not write");
    },
    async commit() {
      throw new Error("Dev check must not write");
    },
    async rollback() {
      throw new Error("Dev check must not write");
    },
  });
  let changed: (() => void) | undefined;
  let reported!: () => void;
  const firstReport = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const logger = createLogger("silent");
  vi.spyOn(logger, "info").mockImplementation((message) => {
    terminal.push(message);
  });
  const probe: Plugin = {
    name: "migration-overlay-probe",
    enforce: "pre",
    configureServer(server) {
      vi.spyOn(server.ws, "send").mockImplementation((...args) => {
        const message: unknown = args[0];
        messages.push(message);
        if (typeof message === "object" && message !== null && "type" in message) {
          if (message.type === "error") reported();
          if (message.type === "full-reload") changed?.();
        }
      });
    },
  };
  const server = await createServer({
    configFile: false,
    root: path,
    customLogger: logger,
    plugins: [probe, migrations({ directory: path, dev: { db, migrator: { dialect } } })],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    await firstReport;
    assert.ok(terminal.length > 0);
    assert.ok(
      messages.some(
        (message) => typeof message === "object" && message !== null && "type" in message && message.type === "error",
      ),
    );
    assert.equal(statements.length, 1);
    const rechecked = new Promise<void>((resolve) => {
      changed = resolve;
    });
    await rm(join(path, "V1__first.sql"));
    server.watcher.emit("unlink", join(path, "V1__first.sql"));
    await rechecked;
    assert.ok(terminal.length >= 2);
    assert.ok(statements.every((statement) => /^\s*SELECT\b/iu.test(statement)));
  } finally {
    await server.close();
    vi.restoreAllMocks();
    await rm(path, { recursive: true, force: true });
  }
});

test("TypeScript loading accepts a defineMigration() result and rejects other default exports", async () => {
  const path = await directory({
    "V1__definition.ts":
      "const run = async (): Promise<void> => {}; export default Object.freeze({ run, transaction: false });",
  });
  try {
    const body = await (await loadMigrations(path, { dialects: ["sqlite"] })).dialects.sqlite!.versioned[0]!.load();
    assert.equal(typeof body, "object");
    assert.equal((body as { transaction: boolean }).transaction, false);
    await writeFile(join(path, "V1__definition.ts"), "export default { run: 1, transaction: false };");
    await assert.rejects((await loadMigrations(path, { dialects: ["sqlite"] })).dialects.sqlite!.versioned[0]!.load(), {
      code: "BRAID_MIGRATE_SOURCE",
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
