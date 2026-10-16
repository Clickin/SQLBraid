/* oxlint-disable no-await-in-loop -- Bundlers share one consumer; edits and server lifecycles must run in order. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const root = resolve(new URL("../..", import.meta.url).pathname);
const consumer = realpathSync(
  process.env.SQLBRAID_WEBPACK_CONSUMER ?? mkdtempSync(join(tmpdir(), "sqlbraid-webpack-")),
);
const fixture = join(root, "tests/fixtures/webpack");
const versions = JSON.parse(readFileSync(join(root, "tests/package.json"))).devDependencies;
if (!process.env.SQLBRAID_WEBPACK_CONSUMER) {
  const packed = resolve(process.env.SQLBRAID_PACK_INPUT_DIR ?? join(root, ".compatibility-packages"));
  const overrides = {};
  for (const file of readdirSync(packed).filter((name) => name.endsWith(".tgz"))) {
    const path = join(packed, file);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
    overrides[manifest.name] = `file:${path}`;
  }
  const dependencies = {
    sqlbraid: overrides.sqlbraid,
    "@sqlbraid/sqlite": overrides["@sqlbraid/sqlite"],
    "@sqlbraid/webpack": overrides["@sqlbraid/webpack"],
    "@sqlbraid/compiler": overrides["@sqlbraid/compiler"],
  };
  for (const name of [
    "webpack",
    "@rspack/core",
    "next",
    "ts-loader",
    "typescript",
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
    "@types/node",
  ])
    dependencies[name] = versions[name];
  assert.ok(dependencies["@sqlbraid/webpack"]);
  assert.ok(dependencies["@sqlbraid/sqlite"], "Missing packed @sqlbraid/sqlite");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    `packages: []\noverrides:\n${Object.entries(overrides)
      .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join("\n")}\n`,
  );
  execFileSync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: consumer, stdio: "inherit" });
}
console.info(`Consumer: ${consumer}`);
cpSync(fixture, consumer, { recursive: true });
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      sourceMap: true,
    },
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules"],
  }),
);
const require = createRequire(join(consumer, "package.json"));
assert.equal(typeof require("@sqlbraid/webpack"), "function");
assert.equal(typeof (await import(pathToFileURL(require.resolve("@sqlbraid/webpack")))).default, "function");
writeFileSync(
  join(consumer, "check.mjs"),
  `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSource } from '@sqlbraid/compiler';
import ts from 'typescript';
for (const file of ['query.ts', 'entry.tsx', 'app/client.tsx', 'app/server.ts', 'app/page.tsx', 'app/layout.tsx']) {
  assert.deepEqual(checkSource(readFileSync(file, 'utf8'), resolve(file), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, esModuleInterop: true,
  } }), [], 'compiler type check: ' + file);
}
`,
);
execFileSync(process.execPath, ["check.mjs"], { cwd: consumer, stdio: "inherit" });
console.info("Compiler narrowing and mapper type checks PASS");
function check(result, marker = "initial") {
  assert.deepEqual(result.inactive.events, ["first", "condition", "last"]);
  assert.deepEqual(result.active.events, ["first", "condition", "active", "last"]);
  assert.equal(result.inactive.text, "SELECT ? , ?");
  assert.equal(result.active.text, "SELECT ? , ? , ?");
  assert.deepEqual(result.inactive.values, [7, 9]);
  assert.deepEqual(result.active.values, [7, 3, 9]);
  assert.equal(result.active.sameMapper, true);
  assert.equal(result.inactive.sameMapper, true);
  assert.deepEqual(result.active.output, { label: marker });
  assert.equal(result.active.marker, marker);
}
const queryPath = join(consumer, "query.ts");
const original = readFileSync(queryPath, "utf8");
const modes = process.argv.slice(2);
for (const engine of ["webpack", "rspack"].filter((name) => !modes.length || modes.includes(name))) {
  const bundler = engine === "webpack" ? require("webpack") : require("@rspack/core").rspack;
  const config = {
    mode: "development",
    context: consumer,
    target: "node",
    entry: "./entry.tsx",
    devtool: "source-map",
    output: { path: join(consumer, engine), filename: "bundle.cjs", library: { type: "commonjs2" } },
    resolve: { extensions: [".tsx", ".ts", ".js"] },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: [
            { loader: require.resolve("ts-loader"), options: { transpileOnly: true } },
            require.resolve("@sqlbraid/webpack"),
          ],
        },
      ],
    },
  };
  const compiler = bundler(config);
  let count = 0;
  await new Promise((resolveWatch, reject) => {
    const timeout = setTimeout(() => watching.close(() => reject(new Error(`${engine} watch timeout`))), 60000);
    const watching = compiler.watch({ poll: 200, ignored: /node_modules/ }, (error, stats) => {
      try {
        if (error) throw error;
        assert.ok(!stats.hasErrors(), stats.toString({ all: false, errors: true }));
        const bundle = join(consumer, engine, "bundle.cjs");
        delete require.cache[require.resolve(bundle)];
        const result = require(bundle);
        check(result, result.active.marker);
        const map = JSON.parse(readFileSync(`${bundle}.map`, "utf8"));
        assert.ok(map.sources.some((name) => name.endsWith("/query.ts")));
        const code = readFileSync(bundle, "utf8");
        const offset = code.indexOf("this.id");
        assert.ok(offset >= 0);
        const lines = code.slice(0, offset).split("\n");
        const origin = originalPositionFor(new TraceMap(map), { line: lines.length, column: lines.at(-1).length });
        assert.ok(origin.source.endsWith("/query.ts"));
        assert.equal(origin.line, original.slice(0, original.indexOf("this.id")).split("\n").length);
        if (count++ === 0) setTimeout(() => writeFileSync(queryPath, original.replace("initial", "updated")), 200);
        else if (result.active.marker === "updated")
          watching.close(() => {
            clearTimeout(timeout);
            resolveWatch();
          });
      } catch (failure) {
        clearTimeout(timeout);
        watching.close(() => reject(failure));
      }
    });
  });
  await new Promise((done, reject) => compiler.close((error) => (error ? reject(error) : done())));
  writeFileSync(queryPath, original);
  console.info(`${engine}: TS/TSX build, execution, source map, watch PASS`);
}
writeFileSync(
  join(consumer, "next.config.mjs"),
  `export default {
  webpack(config) {
    config.module.rules.push({ test: /\\.[cm]?[jt]sx?$/, exclude: /node_modules/, enforce: 'pre', use: ['@sqlbraid/webpack'] });
    return config;
  },
  turbopack: { root: ${JSON.stringify(consumer)}, rules: {
    '*.{ts,tsx,js,jsx}': { condition: { not: 'foreign' }, loaders: ['@sqlbraid/webpack'] }
  } },
  typescript: { ignoreBuildErrors: true }
};\n`,
);
// Next checks original templates; the compiler's separate type gate checks lowered narrowing.
const next = require.resolve("next/dist/bin/next");
async function serve(args, marker, edit) {
  const port = 23000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, [next, ...args, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: consumer,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => {
    log += data;
  });
  child.stderr.on("data", (data) => {
    log += data;
  });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120000;
    while (true) {
      if (child.exitCode !== null) throw new Error(log);
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(15000) })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(log);
      await delay(500);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(url);
    check(JSON.parse(await page.locator("pre").innerText()), marker);
    assert.match(await page.locator("pre").innerText(), /42/);
    await page.getByRole("button", { name: /^client:0:/ }).click();
    await page.getByRole("button", { name: "client:1:SELECT 1", exact: true }).waitFor();
    if (edit) {
      writeFileSync(queryPath, original.replace("initial", "updated"));
      await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes("updated"), undefined, {
        timeout: 60000,
      });
      check(JSON.parse(await page.locator("pre").innerText()), "updated");
    }
    assert.deepEqual(errors, []);
    for (const script of await page.locator("script[src]").evaluateAll((nodes) => nodes.map((node) => node.src))) {
      const content = await (await fetch(script)).text();
      assert.doesNotMatch(content, /node:sqlite|DatabaseSync|createNodeSqliteDatabase/);
    }
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done)));
    writeFileSync(join(consumer, `next-${args.join("-")}.log`), log);
  }
}
for (const mode of ["next-webpack", "next-turbopack"].filter((name) => !modes.length || modes.includes(name))) {
  const flag = mode === "next-webpack" ? "--webpack" : "--turbopack";
  writeFileSync(queryPath, original);
  await serve(["dev", flag], "initial", true);
  console.info(`${mode}: dev, file edit, hydration, server DB boundary PASS`);
  writeFileSync(queryPath, original);
  execFileSync(process.execPath, [next, "build", flag], {
    cwd: consumer,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    timeout: 180000,
  });
  await serve(["start"], "initial", false);
  console.info(`${mode}: production build and execution PASS`);
}
