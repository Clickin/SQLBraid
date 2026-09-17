import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { beforeAll, test } from "vitest";
import { typePolicy } from "@sqlbraid/sqlite";
import { exactJsonText } from "../fidelity.js";
import { stampSupportEnvironment } from "../support-target.js";

interface TransparencyEvidence {
  readonly logicalSegments: readonly string[];
  readonly parameterizedSql: string;
  readonly observedValues: readonly unknown[];
  readonly rows: readonly { readonly marker: string; readonly enabled: string; readonly actual: string }[];
}

interface GeneratedEvidence {
  readonly logicalSegments: readonly string[];
  readonly parameterizedSql: string;
  readonly rows: readonly { readonly name: string }[];
}

interface IntegerValue {
  readonly type: string;
  readonly value: string | number;
}

interface IntegerEvidence {
  readonly realValues: readonly IntegerValue[];
  readonly values: {
    readonly safe: IntegerValue;
    readonly safePlusOne: IntegerValue;
    readonly minimum: IntegerValue;
    readonly maximum: IntegerValue;
  };
}

interface JsonEvidence {
  readonly rows: readonly { readonly payload: string; readonly enabled: string }[];
}

interface BulkEvidence {
  readonly result: { readonly inputCount: number; readonly affectedRows: number };
  readonly parameterizedSql: string;
  readonly executionMode: string;
  readonly prepareCount: number;
  readonly rows: readonly { readonly value: string }[];
}

interface StreamEvidence {
  readonly first: { readonly value: string };
  readonly blockedCode: string;
  readonly rows: readonly string[];
  readonly after: readonly { readonly value: string }[];
}

interface WasmReport {
  readonly runtime: "browser-wasm";
  readonly sqliteVersion: string;
  readonly browserVersion: string;
  readonly environment: {
    readonly capabilities: Readonly<Record<string, { readonly status: string }>>;
  };
  readonly cases: {
    readonly "wasm.sql.native-transparency": TransparencyEvidence;
    readonly "wasm.sql.generated-structure": GeneratedEvidence;
    readonly "wasm.numeric.exact-integer": IntegerEvidence;
    readonly "wasm.data.json-text": JsonEvidence;
    readonly "wasm.execution.bulk": BulkEvidence;
    readonly "wasm.execution.stream": StreamEvidence;
    readonly "wasm.execution.mapped-transaction": {
      readonly session: {
        readonly preparedRow: { readonly value: string };
        readonly markers: readonly { readonly value: string }[];
      };
      readonly inserted: {
        readonly id: string;
        readonly name: string;
        readonly payload: { readonly active: boolean };
        readonly bytes: readonly number[];
        readonly stamp: string;
        readonly uuid: string;
      };
      readonly updated: { readonly id: string; readonly name: string };
      readonly deleted: { readonly id: string };
      readonly remaining: readonly unknown[];
    };
  };
}

const root = resolve(import.meta.dirname, "../../..");
let report: WasmReport;

function parseReport(value: unknown): WasmReport {
  if (
    value === null ||
    typeof value !== "object" ||
    !("runtime" in value) ||
    !("sqliteVersion" in value) ||
    !("cases" in value)
  ) {
    throw new Error("Browser smoke report has an invalid top-level shape.");
  }
  if (
    value.runtime !== "browser-wasm" ||
    typeof value.sqliteVersion !== "string" ||
    value.cases === null ||
    typeof value.cases !== "object"
  ) {
    throw new Error("Browser smoke report does not identify a browser WASM run.");
  }
  const ids = [
    "wasm.sql.native-transparency",
    "wasm.sql.generated-structure",
    "wasm.numeric.exact-integer",
    "wasm.data.json-text",
    "wasm.execution.bulk",
    "wasm.execution.stream",
    "wasm.execution.mapped-transaction",
  ] as const;
  const cases = value.cases;
  if (ids.some((id) => !(id in cases))) throw new Error("Browser smoke report omitted a canonical WASM capability.");
  return value as WasmReport;
}

function runBrowserSmoke(): Promise<WasmReport> {
  const { promise, resolve: resolveReport, reject } = Promise.withResolvers<WasmReport>();
  const child = spawn(process.execPath, [resolve(root, "tests/scripts/test-browser.mjs")], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once("error", reject);
  child.once("close", (code: number | null) => {
    const line = stdout.split("\n").find((entry) => entry.startsWith("SQLBRAID_BROWSER_REPORT="));
    if (code !== 0) {
      reject(new Error(`Browser smoke exited with ${String(code)}.\n${stderr}\n${stdout}`));
      return;
    }
    if (line === undefined) {
      reject(new Error(`Browser smoke emitted no conformance report.\n${stderr}\n${stdout}`));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(line.slice("SQLBRAID_BROWSER_REPORT=".length));
      resolveReport(parseReport(parsed));
    } catch (error) {
      reject(new Error(`Browser smoke emitted malformed conformance JSON: ${String(error)}`));
    }
  });
  return promise;
}

beforeAll(async () => {
  report = await runBrowserSmoke();
  assert.equal(report.runtime, "browser-wasm");
  assert.match(report.sqliteVersion, /^\d+\.\d+\.\d+$/u);
  assert.match(report.browserVersion, /^\d+\.\d+\.\d+\.\d+$/u);
  const driverPackage = JSON.parse(
    readFileSync(resolve(root, "node_modules/@sqlite.org/sqlite-wasm/package.json"), "utf8"),
  );
  stampSupportEnvironment("sqlite-wasm", {
    database: { product: "sqlite", version: report.sqliteVersion, edition: "official SQLite WASM OO1" },
    driver: { id: "sqlite-wasm", version: driverPackage.version, profile: "sqlite-wasm-exact-string" },
    runtime: { id: "browser", version: report.browserVersion },
    typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
  });
}, 180_000);

test("wasm.sql.native-transparency", () => {
  const evidence = report.cases["wasm.sql.native-transparency"];
  assert.deepEqual(evidence.logicalSegments, [
    "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(",
    ", '$.enabled') AS enabled,\n             ",
    " AS actual\n    ",
  ]);
  assert.equal(
    evidence.parameterizedSql,
    "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(?1, '$.enabled') AS enabled,\n             ?2 AS actual\n    ",
  );
  assert.deepEqual(evidence.observedValues, ['{"enabled":true}', 7]);
  assert.deepEqual(evidence.rows, [{ marker: "literal $1 :1 @p1 ?", enabled: "1", actual: "7" }]);
});

test("wasm.capabilities.report physical execution boundaries", () => {
  const capabilities = report.environment?.capabilities;
  assert.ok(capabilities);
  assert.equal(capabilities["session.pinned"]?.status, "guaranteed");
  assert.equal(capabilities.transaction?.status, "guaranteed");
  assert.equal(capabilities["transaction.isolation.serializable"]?.status, "guaranteed");
  assert.equal(capabilities["transaction.read-only"]?.status, "unsupported");
  assert.equal(capabilities["statement.cancel"]?.status, "unsupported");
  assert.equal(capabilities["statement.stream"]?.status, "guaranteed");
  assert.equal(capabilities["statement.bulk"]?.status, "guaranteed");
});

test("wasm.sql.generated-structure", () => {
  const evidence = report.cases["wasm.sql.generated-structure"];
  assert.deepEqual(evidence.logicalSegments, ['INSERT INTO "generated_table" ("name") VALUES (', ")"]);
  assert.equal(evidence.parameterizedSql, 'INSERT INTO "generated_table" ("name") VALUES (?1)');
  assert.deepEqual(evidence.rows, [{ name: "Ada" }]);
});

test("wasm.numeric.exact-integer", () => {
  const evidence = report.cases["wasm.numeric.exact-integer"];
  assert.deepEqual(evidence.values, {
    safe: { type: "string", value: "9007199254740991" },
    safePlusOne: { type: "string", value: "9007199254740992" },
    minimum: { type: "string", value: "-9223372036854775808" },
    maximum: { type: "string", value: "9223372036854775807" },
  });
  assert.deepEqual(evidence.realValues, [
    { type: "number", value: 1 },
    { type: "number", value: 1e20 },
  ]);
});

test("wasm.data.json-text", () => {
  const evidence = report.cases["wasm.data.json-text"];
  assert.deepEqual(evidence.rows, [{ payload: exactJsonText, enabled: "1" }]);
});

test("wasm.execution.bulk", () => {
  const evidence = report.cases["wasm.execution.bulk"];
  assert.deepEqual(evidence.result, { inputCount: 3, affectedRows: 3 });
  assert.equal(evidence.parameterizedSql, "INSERT INTO bulk_values (value) VALUES (?1)");
  assert.equal(evidence.executionMode, "prepared-loop");
  assert.equal(evidence.prepareCount, 2);
  assert.deepEqual(evidence.rows, [{ value: "1" }, { value: "2" }, { value: "3" }]);
});

test("wasm.execution.stream", () => {
  const evidence = report.cases["wasm.execution.stream"];
  assert.deepEqual(evidence.first, { value: "1" });
  assert.equal(evidence.blockedCode, "BRAID_STREAM_SCOPE");
  assert.deepEqual(evidence.rows, ["1", "2", "3"]);
  assert.deepEqual(evidence.after, [{ value: "4" }]);
});

test("wasm.execution.mapped-transaction", () => {
  const evidence = report.cases["wasm.execution.mapped-transaction"];
  assert.deepEqual(evidence.session, {
    preparedRow: { value: "pinned" },
    markers: [{ value: "nested" }],
  });
  assert.deepEqual(evidence.inserted, {
    id: "1",
    name: "ADA",
    payload: { active: true },
    bytes: [0, 128, 255],
    stamp: "2026-09-14T00:00:00.123456Z",
    uuid: "123e4567-e89b-12d3-a456-426614174000",
  });
  assert.deepEqual(evidence.updated, { id: "1", name: "Grace" });
  assert.deepEqual(evidence.deleted, { id: "1" });
  assert.deepEqual(evidence.remaining, []);
});
