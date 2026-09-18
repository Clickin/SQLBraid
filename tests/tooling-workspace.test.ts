import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import type { MetadataSnapshot } from "@sqlbraid/metadata";
import { createWorkspace, loadConfig } from "@sqlbraid/tooling";

function metadata(relation: string): MetadataSnapshot {
  return {
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect: "postgres",
    dialectVersion: "16",
    server: {},
    namespaces: {},
    types: {},
    relations: {
      [`public.${relation}`]: {
        identity: `public.${relation}`,
        name: relation,
        namespace: "public",
        kind: "table",
        columns: [{ name: "id", ordinal: 0, type: "int4", nullable: false }],
      },
    },
    routines: {},
    metadata: {},
  };
}

const policy = {
  id: "test-policy",
  hash: "test-policy-v1",
  mappings: [{ databaseType: "int4", inputType: "number", outputType: "number", nullable: false }],
  decode(_databaseType: string, value: unknown) {
    return value;
  },
  encode(_databaseType: string, value: unknown) {
    return value;
  },
};

function config(relation: string): string {
  return `export default ${JSON.stringify({ codegen: { targets: [{ name: relation, metadata: "./metadata.json", outFile: "./generated.ts", typePolicy: { id: policy.id, hash: policy.hash, mappings: policy.mappings } }] } })};`;
}

test("workspace refreshes unsaved source and metadata evidence without writing generated output", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  try {
    const file = join(directory, "query.ts");
    const metadataFile = join(directory, "metadata.json");
    const configFile = join(directory, "sqlbraid.config.mjs");
    await writeFile(metadataFile, JSON.stringify(metadata("users")));
    await writeFile(configFile, config("users"));
    const staleGenerated = "export interface UsersRow { id: string; }\n";
    await writeFile(join(directory, "generated.ts"), staleGenerated);
    const workspace = createWorkspace({ rootPath: directory, configPath: configFile });
    workspace.setDocument(
      file,
      'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;',
      1,
    );
    const first = await workspace.service();
    const staleDefinition = first.definition(
      'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;',
      file,
      'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;'.indexOf("users"),
    );
    assert.ok(staleDefinition?.uri.endsWith("/metadata.json"));
    assert.equal(await readFile(join(directory, "generated.ts"), "utf8"), staleGenerated);

    const changedSource = 'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM orders`;';
    workspace.setDocument(file, changedSource, 2);
    const second = await workspace.service();
    assert.equal((await second.references(changedSource, file, changedSource.indexOf("orders"))).length, 0);
    await writeFile(metadataFile, JSON.stringify(metadata("orders")));
    const third = await workspace.service();
    assert.ok(third.definition(changedSource, file, changedSource.indexOf("orders"))?.uri.endsWith("/metadata.json"));
    assert.equal(
      third.definition(
        'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;',
        file,
        'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;'.indexOf("users"),
      ),
      undefined,
    );
    const loaded = await loadConfig(configFile, directory);
    assert.equal(loaded.config.codegen?.targets[0]?.name, "users");
    await writeFile(configFile, config("orders"));
    const changed = await loadConfig(configFile, directory);
    assert.equal(changed.config.codegen?.targets[0]?.name, "orders");
    workspace.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace reference coverage is exhaustive beyond bounded caches and keeps unsaved documents", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  const workspace = createWorkspace({
    rootPath: directory,
    configPath: join(directory, "sqlbraid.config.mjs"),
    maxEntries: 1,
  });
  try {
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata("users")));
    await writeFile(join(directory, "sqlbraid.config.mjs"), config("users"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
    const source = 'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM public.users`;';
    const queryFile = join(directory, "query.ts");
    const diskFiles = Array.from({ length: 260 }, (_, index) => join(directory, `disk-${index}.ts`));
    await Promise.all(diskFiles.map((file) => writeFile(file, source)));
    const unsavedFiles = [join(directory, "unsaved-a.ts"), join(directory, "unsaved-b.ts")];
    workspace.setDocument(queryFile, source, 1);
    for (const [index, file] of unsavedFiles.entries()) workspace.setDocument(file, source, index + 2);

    const service = await workspace.service();
    const references = await service.references(source, queryFile, source.indexOf("public.users"));
    assert.equal(references.length, 263);
    assert.equal(
      references.some((reference) => reference.uri.endsWith("/query.ts")),
      true,
    );
    assert.equal(
      references.some((reference) => reference.uri.endsWith("/disk-259.ts")),
      true,
    );
    assert.equal(
      references.some((reference) => reference.uri.endsWith("/unsaved-a.ts")),
      true,
    );
    assert.equal(
      references.some((reference) => reference.uri.endsWith("/unsaved-b.ts")),
      true,
    );
    let checks = 0;
    const cancellation = {
      get isCancellationRequested(): boolean {
        checks += 1;
        return checks > 8;
      },
    };
    assert.deepEqual(await service.references(source, queryFile, source.indexOf("public.users"), cancellation), []);
  } finally {
    workspace.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace hover does not read every indexed project source", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  const workspace = createWorkspace({ rootPath: directory, configPath: join(directory, "sqlbraid.config.mjs") });
  try {
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata("users")));
    await writeFile(join(directory, "sqlbraid.config.mjs"), config("users"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
    const indexedSource = join(directory, "indexed.ts");
    await writeFile(indexedSource, 'export const unrelated = "source";');
    const queryFile = join(directory, "query.ts");
    const source = 'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM public.users`;';
    workspace.setDocument(queryFile, source, 1);
    const first = await workspace.service();
    assert.match(
      first.hover(source, queryFile, source.indexOf("public.users"))?.contents ?? "",
      /^Relation public.users/u,
    );

    await rm(indexedSource, { force: true });
    await mkdir(indexedSource);
    const second = await workspace.service();
    assert.match(
      second.hover(source, queryFile, source.indexOf("public.users"))?.contents ?? "",
      /^Relation public.users/u,
    );
  } finally {
    workspace.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one cancelled workspace caller does not cancel another caller's shared refresh", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  const workspace = createWorkspace({ rootPath: directory });
  try {
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata("users")));
    await writeFile(
      join(directory, "sqlbraid.config.mjs"),
      `await new Promise(resolve => setTimeout(resolve, 100));\n${config("users")}`,
    );
    const cancellation = { isCancellationRequested: false };
    const cancelled = workspace.service(cancellation);
    const active = workspace.service();
    setTimeout(() => {
      cancellation.isCancellationRequested = true;
    }, 10);
    const [cancelledResult, activeResult] = await Promise.allSettled([cancelled, active]);
    assert.equal(cancelledResult.status, "rejected");
    assert.equal(activeResult.status, "fulfilled");
    if (activeResult.status === "fulfilled") {
      const source = 'import { sql } from "@sqlbraid/template"; const q = sql`SELECT * FROM users`;';
      assert.ok(
        activeResult.value
          .definition(source, join(directory, "query.ts"), source.indexOf("users"))
          ?.uri.endsWith("/metadata.json"),
      );
    }
  } finally {
    workspace.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disposing a workspace terminates an in-flight executable config", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  const workspace = createWorkspace({ rootPath: directory });
  try {
    const started = join(directory, "started");
    await writeFile(
      join(directory, "sqlbraid.config.mjs"),
      `import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(started)}, "started");
await new Promise(resolve => setTimeout(resolve, 60_000));
export default {};`,
    );
    const outcome = workspace.service().then(
      () => undefined,
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await readFile(started, "utf8").catch(() => "")) === "started") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readFile(started, "utf8"), "started");
    workspace.dispose();
    const error = await outcome;
    assert.ok(error instanceof Error && error.name === "WorkspaceCancellationError");
  } finally {
    workspace.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 3_000);

test("workspace cancellation stops asynchronous config loading", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  try {
    const configFile = join(directory, "sqlbraid.config.mjs");
    await writeFile(configFile, `export default ${JSON.stringify({})};`);
    const workspace = createWorkspace({ rootPath: directory, configPath: configFile });
    await assert.rejects(
      workspace.service({ isCancellationRequested: true }),
      (error: unknown) => error instanceof Error && error.name === "WorkspaceCancellationError",
    );
    const slowConfig = join(directory, "slow.config.mjs");
    await writeFile(slowConfig, "await new Promise((resolve) => setTimeout(resolve, 100)); export default {};\n");
    const cancellation = { isCancellationRequested: false };
    const pending = loadConfig(slowConfig, directory, cancellation);
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancellation.isCancellationRequested = true;
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === "ConfigurationCancellationError",
    );
    workspace.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsaved generated output never contributes stale navigation offsets", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  try {
    const file = join(directory, "query.ts");
    const metadataFile = join(directory, "metadata.json");
    const configFile = join(directory, "sqlbraid.config.mjs");
    const outputFile = join(directory, "generated.ts");
    const generated = generateModels(metadata("users"), { typePolicy: policy }).source;
    await writeFile(metadataFile, JSON.stringify(metadata("users")));
    await writeFile(configFile, config("users"));
    await writeFile(outputFile, generated);
    const source = 'import { sql } from "@sqlbraid/template"; export const query = sql`SELECT id FROM users`;';
    const relationOffset = source.indexOf("users");
    const workspace = createWorkspace({ rootPath: directory, configPath: configFile });
    workspace.setDocument(file, source, 1);
    const current = await workspace.service();
    assert.ok(current.definition(source, file, relationOffset)?.uri.endsWith("/generated.ts"));

    workspace.setDocument(outputFile, `${generated}\n// edited\n`, 2);
    workspace.invalidate();
    const stale = await workspace.service();
    assert.ok(stale.definition(source, file, relationOffset)?.uri.endsWith("/metadata.json"));

    workspace.closeDocument(outputFile);
    workspace.invalidate();
    const restored = await workspace.service();
    assert.ok(restored.definition(source, file, relationOffset)?.uri.endsWith("/generated.ts"));
    workspace.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated config loading refreshes CJS dependencies", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".sqlbraid-workspace-"));
  try {
    const dependency = join(directory, "config-dependency.cjs");
    const configFile = join(directory, "sqlbraid.config.cjs");
    const configSource =
      'module.exports = { codegen: { targets: [{ name: require("./config-dependency.cjs").name, metadata: "./missing.json", outFile: "./generated.ts", typePolicy: { id: "policy", hash: "policy", mappings: [] } }] } };';
    await writeFile(dependency, 'exports.name = "first";\n');
    await writeFile(configFile, configSource);
    const first = await loadConfig(configFile, directory);
    assert.equal(first.config.codegen?.targets[0]?.name, "first");
    await writeFile(dependency, 'exports.name = "second";\n');
    const second = await loadConfig(configFile, directory);
    assert.equal(second.config.codegen?.targets[0]?.name, "second");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
