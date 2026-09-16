#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageDir = resolve(process.env.SQLBRAID_PACK_INPUT_DIR ?? join(root, ".compatibility-packages"));
const consumer = mkdtempSync(join(tmpdir(), "sqlbraid-otel-api-") );
const tarballs = new Map();
for (const file of readdirSync(packageDir)) if (file.endsWith(".tgz")) {
  const path = join(packageDir, file);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
  tarballs.set(manifest.name, `file:${path}`);
}
for (const name of ["@sqlbraid/opentelemetry", "@sqlbraid/core"]) if (!tarballs.has(name)) throw new Error(`Missing candidate tarball: ${name}`);
writeFileSync(join(consumer, "package.json"), JSON.stringify({
  name: "sqlbraid-otel-api-consumer", private: true, type: "module",
  dependencies: { "@sqlbraid/opentelemetry": tarballs.get("@sqlbraid/opentelemetry"), "@sqlbraid/core": tarballs.get("@sqlbraid/core"), "@opentelemetry/api": "1.9.1" },
}, null, 2));
execFileSync("npm", ["install", "--engine-strict", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, stdio: "inherit", env: { ...process.env, npm_config_engine_strict: "true" } });
const { trace } = await import(join(consumer, "node_modules/@opentelemetry/api/build/esm/index.js"));
const { createOpenTelemetryObserver } = await import(join(consumer, "node_modules/@sqlbraid/opentelemetry/dist/index.js"));
const observer = createOpenTelemetryObserver({});
assert.equal(typeof observer.onEvent, "function");
const operationId = "api-floor-operation";
const ready = {
  type: "query:ready", operationId, values: [], execution: { adapterId: "api-floor", dialectId: "postgres", transport: "text-positional", reuse: "simple" },
  literalizedSql: () => ({ text: "SELECT 1", truncated: false }), declaredKind: "rows", transactionDepth: 0, transactionScoped: false,
};
await observer.onEvent(ready);
await observer.onEvent({ type: "query:result", operationId, durationMs: 0, actualKind: "rows", transactionDepth: 0, transactionScoped: false });
assert.ok(trace.getTracer("sqlbraid"));
console.info(`PASS packed OTel API-only consumer at Node ${process.versions.node}: ${consumer}`);
