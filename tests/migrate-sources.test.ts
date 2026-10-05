import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { createLogger, createServer } from "vite";
import type { Plugin } from "vite";
import { createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { dialect } from "@sqlbraid/sqlite";
import { compareVersions, normalizeVersion } from "../packages/migrate/src/manifest.js";
import { generateManifestModule, loadMigrations } from "../packages/migrate/src/node.js";
import { normalizeSource } from "../packages/migrate/src/sources.js";
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
    assert.equal(entry.sql, "SELECT 1;\n  \n");
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
    assert.equal(manifest.dialects.postgres!.versioned[0]!.sql, "postgres earlier");
    assert.equal(manifest.dialects.sqlite!.versioned[0]!.sql, "generic earlier");
    assert.equal(manifest.dialects.postgres!.repeatable[0]!.sql, "postgres view");
    assert.equal(manifest.dialects.sqlite!.repeatable[0]!.sql, "generic view");
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
    assert.match(manifest.dialects.sqlite!.versioned[0]!.sql, /linked/u);
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
    assert.equal(manifest.dialects.sqlite!.versioned[0]!.sql, "");
    assert.equal(manifest.dialects.postgres!.versioned[0]!.version, manifest.dialects.sqlite!.versioned[0]!.version);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("duplicate canonical versions are rejected", async () => {
  const path = await directory({ "V001__first.sql": "", "V1.0__first.sql": "" });
  try {
    await assert.rejects(loadMigrations(path), { code: "BRAID_MIGRATE_SOURCE" });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("migration-named files other than .sql fail instead of being skipped; other files are ignored", async () => {
  for (const file of ["V1__seed.ts", "V2__seed.js", "R__view.mjs", "V3__notes.txt"]) {
    const path = await directory({ "V0__init.sql": "", [file]: "export default async () => {}" });
    try {
      await assert.rejects(loadMigrations(path), (error: Error & { code?: string }) => {
        assert.equal(error.code, "BRAID_MIGRATE_SOURCE");
        assert.match(error.message, /SQL files only/u);
        return true;
      });
      await assert.rejects(generateManifestModule(path), { code: "BRAID_MIGRATE_SOURCE" });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
  const path = await directory({ "V1__init.sql": "", "README.md": "", "Vendor__notes.ts": "", "seed.ts": "" });
  try {
    const manifest = await loadMigrations(path, { dialects: ["sqlite"] });
    assert.deepEqual(
      manifest.dialects.sqlite!.versioned.map((entry) => entry.source),
      ["V1__init.sql"],
    );
  } finally {
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
    assert.equal(postgres.versioned[0]!.sql, "CREATE TABLE t (id integer);");
    await assert.rejects(generateManifestModule(path, { dialects: ["mysql"] }), /No mysql or generic source/u);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("generated ESM has no imports, embeds normalized SQL and keeps source identities", async () => {
  const path = await directory({ "V1__sql.sql": "SELECT 1;\r\n", "R__view.sql": "CREATE VIEW v AS SELECT 1;" });
  try {
    const expected = await loadMigrations(path, { dialects: ["sqlite"] });
    const generated = await generateManifestModule(path, { dialects: ["sqlite"] });
    assert.ok(!/\bimport\b/u.test(generated));
    const outfile = join(path, "manifest.mjs");
    await writeFile(outfile, generated);
    // The generated module path exists only for this test run.
    const module: { default: MigrationManifest } = await import(pathToFileURL(outfile).href);
    assert.deepEqual(JSON.parse(JSON.stringify(module.default)), JSON.parse(JSON.stringify(expected)));
    assert.equal(module.default.dialects.sqlite!.versioned[0]!.sql, "SELECT 1;\n");
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
