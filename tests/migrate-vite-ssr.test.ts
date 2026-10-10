import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { build, createServer } from "vite";
import migrations from "@sqlbraid/migrate/vite";

const exec = promisify(execFile);
const MARKER = "sqlbraid_secret_marker";

/** A Node server project inside tests/, so its output resolves the workspace packages. */
async function project(): Promise<{ readonly root: string; remove(): Promise<void> }> {
  const root = await mkdtemp(resolve("tests/.migrate-ssr-"));
  await mkdir(join(root, "migrations"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "migrations/V1__create.sql"), `CREATE TABLE ${MARKER} (value TEXT);\n`);
  await writeFile(join(root, "migrations/V2__seed.sql"), `INSERT INTO ${MARKER} (value) VALUES ('seeded');\n`);
  await writeFile(
    join(root, "src/server.mjs"),
    `import { DatabaseSync } from "node:sqlite";
import { createMigrator } from "@sqlbraid/migrate";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import manifest from "virtual:sqlbraid-migrations";
const native = new DatabaseSync(":memory:");
const db = createNodeSqliteDatabase(native);
const migrator = createMigrator({ manifest, dialect });
const applied = await migrator.startup(db, { mode: "apply" });
const verified = await migrator.startup(db);
const rows = await db.all(sql.rows\`SELECT value FROM ${MARKER}\`);
native.close();
console.log(JSON.stringify({ applied: applied.status, verified: verified.status, rows }));
`,
  );
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}

async function files(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

test("a Vite SSR build inlines migration SQL into the server chunk, emits no SQL asset, and applies on Node", async () => {
  const p = await project();
  try {
    const outDir = join(p.root, "dist/server");
    await build({
      configFile: false,
      root: p.root,
      logLevel: "silent",
      plugins: [migrations({ dialects: ["sqlite"] })],
      build: { ssr: "src/server.mjs", outDir, emptyOutDir: true },
    });
    const output = await files(outDir);
    assert.deepEqual(
      output.filter((file) => file.endsWith(".sql")),
      [],
    );
    const sources = await Promise.all(output.map((file) => readFile(file, "utf8")));
    assert.ok(sources.some((source) => source.includes(`CREATE TABLE ${MARKER}`)));
    const run = await exec(process.execPath, [join(outDir, "server.js")], { cwd: p.root });
    assert.deepEqual(JSON.parse(run.stdout), {
      applied: "current",
      verified: "current",
      rows: [{ value: "seeded" }],
    });
  } finally {
    await p.remove();
  }
}, 60_000);

test("a client build rejects the migration manifest and migration files imported as ?raw or ?url", async () => {
  const p = await project();
  try {
    const entries = {
      "virtual.mjs": 'import manifest from "virtual:sqlbraid-migrations"; console.log(manifest);',
      "raw.mjs": 'import text from "../migrations/V1__create.sql?raw"; console.log(text);',
      "url.mjs": 'import url from "../migrations/V1__create.sql?url"; console.log(url);',
    };
    await Promise.all(
      Object.entries(entries).map(async ([name, source]) => {
        await writeFile(join(p.root, "src", name), source);
        await assert.rejects(
          build({
            configFile: false,
            root: p.root,
            logLevel: "silent",
            plugins: [migrations({ dialects: ["sqlite"] })],
            build: { outDir: join(p.root, "dist", name), rollupOptions: { input: join(p.root, "src", name) } },
          }),
          /server-only/u,
          name,
        );
      }),
    );
    const emitted = await files(join(p.root, "dist")).catch(() => []);
    const contents = await Promise.all(emitted.map((file) => readFile(file, "utf8")));
    assert.ok(contents.every((content) => !content.includes(MARKER)));
  } finally {
    await p.remove();
  }
}, 60_000);

test("the development server never returns migration SQL over HTTP and still serves it to SSR", async () => {
  const p = await project();
  const server = await createServer({
    configFile: false,
    root: p.root,
    logLevel: "silent",
    plugins: [migrations({ dialects: ["sqlite"] })],
    server: { port: 0, host: "127.0.0.1" },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    await symlink(join(p.root, "migrations"), join(p.root, "linked"), "dir");
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    const file = join(p.root, "migrations/V1__create.sql");
    const requests = [
      "/Migrations/V1__create.sql",
      "/MIGRATIONS/V1__create.sql?raw",
      `/@fs${join(p.root, "MIGRATIONS/V1__create.sql")}`,
      "/linked/V1__create.sql",
      "/linked/V1__create.sql?raw",
      `/@fs${join(p.root, "linked/V1__create.sql")}`,
      "/migrations/V1__create.sql",
      "/migrations/V1__create.sql?raw",
      "/migrations/V1__create.sql?url",
      "/migrations/V1__create.sql?import&raw",
      "/migrations/%561__create.sql",
      "/src/../migrations/V1__create.sql",
      `/@fs${file}`,
      `/@fs${file}?raw`,
      "/@id/__x00__virtual:sqlbraid-migrations",
      "/@id/virtual:sqlbraid-migrations",
    ];
    await Promise.all(
      requests.map(async (path) => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const body = await response.text();
        assert.notEqual(response.status, 200, path);
        assert.ok(!body.includes(MARKER), `${path} returned migration SQL`);
      }),
    );
    const module = (await server.ssrLoadModule("virtual:sqlbraid-migrations")) as {
      default: { dialects: { sqlite: { versioned: readonly { sql: string }[] } } };
    };
    assert.match(module.default.dialects.sqlite.versioned[0]!.sql, new RegExp(MARKER, "u"));
  } finally {
    await server.close();
    await p.remove();
  }
}, 60_000);

test("a migrations directory inside publicDir is rejected before it can be copied to client output", async () => {
  const p = await project();
  try {
    await mkdir(join(p.root, "public/migrations"), { recursive: true });
    await assert.rejects(
      build({
        configFile: false,
        root: p.root,
        logLevel: "silent",
        plugins: [migrations({ directory: "public/migrations", dialects: ["sqlite"] })],
        build: { ssr: "src/server.mjs", outDir: join(p.root, "dist/server") },
      }),
      /inside publicDir/u,
    );
  } finally {
    await p.remove();
  }
}, 60_000);
