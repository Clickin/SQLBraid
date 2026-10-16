import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "vitest";
import ts from "typescript";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { transformSource, checkSource } from "@sqlbraid/compiler";

const require = createRequire(import.meta.url);
const loader = require("../packages/webpack/dist/index.cjs");
function invoke(source: string, options: unknown = {}, map?: unknown, file = "/src/query.ts") {
  const errors: Error[] = [];
  const warnings: Error[] = [];
  let cacheable = false;
  return new Promise<{
    code: string;
    map: ConstructorParameters<typeof TraceMap>[0];
    errors: Error[];
    warnings: Error[];
    cacheable: boolean;
  }>((resolve, reject) => {
    loader.call(
      {
        resourcePath: file,
        getOptions: () => options,
        cacheable(value: boolean) {
          cacheable = value;
        },
        emitError(error: Error) {
          errors.push(error);
        },
        emitWarning(error: Error) {
          warnings.push(error);
        },
        async() {
          return (error: Error | null, code: string, outputMap: ConstructorParameters<typeof TraceMap>[0]) => {
            if (error) reject(Object.assign(error, { errors }));
            else resolve({ code, map: outputMap, errors, warnings, cacheable });
          };
        },
      },
      source,
      map,
    );
  });
}
const source =
  '"use client";\nimport { sql } from "@sqlbraid/sqlite";\nexport const query = sql`SELECT 1 /*@braid if ${false}*/ , ${missing()} /*@braid end*/`;';

test("loader preserves prologues, compiler output, maps and passthrough identity", async () => {
  const result = await invoke(source);
  assert.equal(result.code, transformSource(source, "/src/query.ts").code);
  assert.ok(result.code.startsWith('"use client";'));
  assert.equal(result.cacheable, true);
  const upstream = {
    version: 3,
    sources: ["original.ts"],
    names: [],
    mappings: "AAAA;AACA;AACA",
    sourcesContent: [source],
  };
  const plain = await invoke("const x: number = 1", {}, upstream);
  assert.equal(plain.map, upstream);
  const unchangedStringMap = await invoke("const x = 1", {}, JSON.stringify(upstream));
  assert.equal(typeof unchangedStringMap.map, "object");
  assert.equal(originalPositionFor(new TraceMap(unchangedStringMap.map), { line: 2, column: 0 }).line, 2);
  await Promise.all(
    [upstream, JSON.stringify(upstream)].map(async (input) => {
      const composed = await invoke(source, {}, input);
      const offset = composed.code.indexOf("missing()");
      const lines = composed.code.slice(0, offset).split("\n");
      const origin = originalPositionFor(new TraceMap(composed.map), {
        line: lines.length,
        column: lines.at(-1)!.length,
      });
      assert.equal(origin.source, "original.ts");
      assert.equal(origin.line, 3);
    }),
  );
});

test("loader rejects options and reports compiler errors with original file locations", async () => {
  await Promise.all(
    [{ typo: true }, { tagExport: 1 }, { moduleSpecifiers: [1] }, null, []].map((options) =>
      assert.rejects(invoke(source, options), /option|tagExport|moduleSpecifiers/i),
    ),
  );
  const invalid = 'import { sql } from "@sqlbraid/sqlite";\nconst q = sql`SELECT 1 /*@braid otherwise*/`;';
  await assert.rejects(invoke(invalid), (error: unknown) => {
    assert.ok(error instanceof Error && "errors" in error && Array.isArray(error.errors));
    assert.match(error.errors[0].message, /BRAID_STRUCTURE.*\/src\/query.ts:2:/);
    return true;
  });
  await assert.rejects(
    invoke(
      invalid,
      {},
      {
        version: 3,
        sources: ["authored.ts"],
        names: [],
        mappings: "AAAA;AAKA",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "errors" in error && Array.isArray(error.errors));
      assert.match(error.errors[0].message, /authored.ts:6:1/);
      return true;
    },
  );
  const custom = await invoke(source.replace("@sqlbraid/sqlite", "@app/sql"), {
    moduleSpecifiers: ["@app/sql"],
    tagExport: "sql",
  });
  assert.match(custom.code, /__sqlbraidCapture/);
});

test("compiler checker preserves narrowing and mapper output for loader input", async () => {
  const directory = mkdtempSync(join(process.cwd(), "tests/.webpack-types-"));
  try {
    const input = readFileSync(new URL("./fixtures/webpack/query.ts", import.meta.url), "utf8");
    const file = join(directory, "query.ts");
    const lowered = await invoke(input, {}, undefined, file);
    assert.match(lowered.code, /value.id/);
    assert.deepEqual(
      checkSource(input, file, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
      }),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
