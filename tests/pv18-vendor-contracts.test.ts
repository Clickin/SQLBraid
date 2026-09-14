import assert from "node:assert/strict";
import { test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import { sql as oracleSql, typePolicy as oracleTypePolicy } from "@sqlbraid/oracle";
import { createOracledbExecutor, type OracleDriverLike } from "@sqlbraid/oracle/oracledb";
import { mssqlParameter, sql as mssqlSql, typePolicy as mssqlTypePolicy } from "@sqlbraid/mssql";
import { createTediousExecutor, tediousStatementBinding, type TediousConnectionLike, type TediousRequestLike } from "@sqlbraid/mssql/tedious";
import { assertGeneratedProperty } from "./db/codegen.js";

function mockMssqlConnection(run: (request: TediousRequestLike) => void): TediousConnectionLike {
  return {
    execSql: run,
    beginTransaction(callback: (error?: unknown) => void) { callback(); },
    commitTransaction(callback: (error?: unknown) => void) { callback(); },
    rollbackTransaction(callback: (error?: unknown) => void) { callback(); },
    saveTransaction(callback: (error?: unknown) => void) { callback(); },
  };
}

function emit(request: TediousRequestLike, event: string, ...args: unknown[]): void {
  (request as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(event, ...args);
}

function snapshot(dialect: string, columns: readonly { readonly name: string; readonly type: string; readonly nullable?: boolean }[]) {
  return {
    format: "sqlbraid-metadata" as const,
    formatVersion: 1 as const,
    dialect,
    dialectVersion: "pv18",
    server: {},
    namespaces: {},
    types: {},
    relations: {
      "dbo.vendor_contract": {
        identity: "dbo.vendor_contract",
        name: "vendor_contract",
        namespace: "dbo",
        kind: "table" as const,
        columns: columns.map((column, ordinal) => ({ ...column, ordinal, nullable: column.nullable ?? true })),
      },
    },
    routines: {},
    metadata: {},
  };
}

test("PV18 first-party vendor policies are deeply immutable and cover inspector spellings", () => {
  for (const policy of [oracleTypePolicy, mssqlTypePolicy]) {
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.mappings), true);
    for (const mapping of policy.mappings) {
      assert.equal(Object.isFrozen(mapping), true, mapping.databaseType);
      if (mapping.numeric !== undefined) assert.equal(Object.isFrozen(mapping.numeric), true, mapping.databaseType);
    }
  }

  for (const databaseType of ["CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR2", "NUMBER", "JSON", "RAW", "ROWID", "UROWID", "OBJECT", "VECTOR"]) {
    assert.ok(oracleTypePolicy.mappings.some((mapping) => mapping.databaseType === databaseType), databaseType);
  }
  for (const databaseType of ["char", "binary", "timestamp", "uniqueidentifier", "sql_variant", "decimal", "numeric", "money", "smallmoney", "datetime2"]) {
    assert.ok(mssqlTypePolicy.mappings.some((mapping) => mapping.databaseType === databaseType), databaseType);
  }
});

test("Oracle DB_TYPE_JSON keeps every parsed JSON root in the native domain", async () => {
  const jsonType = Symbol("DB_TYPE_JSON");
  const driver: OracleDriverLike = { DB_TYPE_JSON: jsonType };
  const roots = {
    objectRoot: { enabled: true },
    arrayRoot: [1, "two"],
    stringRoot: "text",
    numberRoot: 42,
    booleanRoot: false,
    nullRoot: null,
  } as const;
  const connection = {
    async execute() {
      return {
        rows: [roots],
        metaData: Object.keys(roots).map((name) => ({ name, dbType: jsonType })),
      };
    },
    async commit() {},
    async rollback() {},
  };
  const result = await createOracledbExecutor(connection, { driver }).query(oracleSql.rows`SELECT payload FROM dual`.render());
  assert.equal(result.kind, "rows");
  if (result.kind !== "rows") throw new Error("Oracle JSON contract did not return rows.");
  assert.deepEqual(result.rows, [roots]);
});

test("Oracle NUMBER remains exact-string only while object/vector mappings stay open", async () => {
  const connection = {
    async execute() {
      return { rows: [{ value: 1 }], metaData: [{ name: "value", dbTypeName: "NUMBER" }] };
    },
    async commit() {},
    async rollback() {},
  };
  await assert.rejects(
    () => createOracledbExecutor(connection).query(oracleSql.rows`SELECT value FROM dual`.render()),
    { code: "BRAID_RESULT_EXACTNESS" },
  );
  assert.equal(oracleTypePolicy.mappings.find((mapping) => mapping.databaseType === "OBJECT")?.outputType, "unknown");
  assert.equal(oracleTypePolicy.mappings.find((mapping) => mapping.databaseType === "VECTOR")?.outputType, "unknown");
  const environment = createOracledbExecutor(connection).environment;
  assert.ok(environment);
  assert.equal(environment.capabilities["data.oracle-object"]?.status, "unsupported");
  assert.equal(environment.capabilities["data.oracle-collection"]?.status, "unsupported");
  assert.equal(environment.capabilities["data.vector"]?.status, "unsupported");
});

test("MSSQL canonicalizes integer transport but leaves sql_variant driver values unclassified", async () => {
  const variant = { baseType: "int", payload: 9007199254740993 };
  const executor = createTediousExecutor(mockMssqlConnection((request) => {
    emit(request, "columnMetadata", [
      { colName: "exact", type: "Int" },
      { colName: "variant", type: "Variant" },
    ]);
    emit(request, "row", [{ value: 7 }, { value: variant }]);
    emit(request, "doneInProc", 1);
    emit(request, "requestCompleted");
  }));
  const result = await executor.query(mssqlSql.rows`SELECT 7 AS exact, CAST(7 AS sql_variant) AS variant`.render());
  assert.equal(result.kind, "rows");
  if (result.kind !== "rows") throw new Error("MSSQL variant contract did not return rows.");
  assert.deepEqual(result.rows, [{ exact: "7", variant }]);
  const environment = executor.environment;
  assert.ok(environment);
  assert.equal(environment.capabilities["data.sql-variant"]?.status, "unsupported");
  assert.deepEqual(environment.capabilities["data.sql-variant"]?.rawRepresentations, ["driver-native"]);
});

test("MSSQL native decimal helpers are bounded Number compatibility, while exact text stays authored", () => {
  assert.equal(mssqlTypePolicy.encode("decimal", 12.34), 12.34);
  assert.equal(mssqlTypePolicy.encode("money", -7.89), -7.89);
  assert.throws(() => mssqlTypePolicy.encode("numeric", "12.34"), TypeError);
  assert.throws(() => mssqlTypePolicy.encode("decimal", 1_234_567_890_123_456), TypeError);
  assert.throws(() => mssqlTypePolicy.encode("smallmoney", 1.23456), TypeError);

  const exact = mssqlSql`SELECT CAST(${mssqlSql.bind("12345678901234567890.1234", mssqlParameter.nvarchar("max"))} AS decimal(38, 4))`;
  const binding = tediousStatementBinding.describe(exact.render(), { dialectId: "mssql", requestedReuse: "auto" });
  assert.equal(binding.parameterizedSql, "SELECT CAST(@p1 AS decimal(38, 4))");
  assert.equal(exact.render().segments.join(""), "SELECT CAST( AS decimal(38, 4))");
});

test("Oracle and MSSQL known types remain codegen-visible without recursive container claims", () => {
  const oracle = generateModels(snapshot("oracle", [
    { name: "text_value", type: "VARCHAR2" },
    { name: "json_value", type: "JSON" },
    { name: "raw_value", type: "RAW" },
    { name: "number_value", type: "NUMBER" },
    { name: "object_value", type: "OBJECT" },
    { name: "vector_value", type: "VECTOR" },
  ]), { typePolicy: oracleTypePolicy });
  assert.deepEqual(oracle.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_DATABASE_TYPE"), []);
  assertGeneratedProperty(oracle.source, "VendorContractRow", "json_value", "unknown | null", false);
  assertGeneratedProperty(oracle.source, "VendorContractRow", "raw_value", "Uint8Array | null", false);

  const mssql = generateModels(snapshot("mssql", [
    { name: "text_value", type: "nvarchar" },
    { name: "binary_value", type: "binary" },
    { name: "timestamp_value", type: "timestamp" },
    { name: "uuid_value", type: "uniqueidentifier" },
    { name: "decimal_value", type: "decimal" },
    { name: "variant_value", type: "sql_variant" },
    { name: "temporal_value", type: "datetime2" },
  ]), { typePolicy: mssqlTypePolicy });
  assert.deepEqual(mssql.diagnostics.filter((diagnostic) => diagnostic.code === "CODEGEN_UNKNOWN_DATABASE_TYPE"), []);
  assertGeneratedProperty(mssql.source, "VendorContractRow", "binary_value", "Uint8Array | null", false);
  assertGeneratedProperty(mssql.source, "VendorContractRow", "variant_value", "unknown | null", false);
});

