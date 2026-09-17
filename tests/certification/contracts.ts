import type { ExpectedCapability, ExpectedCapabilityContract, ExpectedGuardedCaseContract, CertificationTarget, CertificationTuple, TransactionOptionKey } from "./types.js";
type BunSqlDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

export const POSTGRES_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = Object.freeze({
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": { status: "guarded", conditionCode: "pg.read-uncommitted-maps-to-read-committed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guarded", conditionCode: "pg.physical-connection-destroy" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "guaranteed" },
  "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.approximate-float": { status: "guarded", canonical: "number", rawRepresentations: ["number"], conditionCode: "pg.extra-float-digits" },
  "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.json-parsed": { status: "unsupported", rawRepresentations: ["unknown"], conditionCode: "pg.json-parser-profile" },
  "data.temporal-lossless": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-native": { status: "unsupported", rawRepresentations: ["Date", "string", "unknown"], conditionCode: "pg.temporal-parser-profile" },
});

export const POSTGRES_EXPECTED_TRANSACTION_OPTIONS = Object.freeze({
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "guaranteed",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "guaranteed",
  "combination:read-uncommitted+readWrite": "guaranteed",
  "combination:read-committed+readOnly": "guaranteed",
  "combination:read-committed+readWrite": "guaranteed",
  "combination:repeatable-read+readOnly": "guaranteed",
  "combination:repeatable-read+readWrite": "guaranteed",
  "combination:serializable+readOnly": "guaranteed",
  "combination:serializable+readWrite": "guaranteed",
});

export const MYSQL2_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = {
  "session.pinned": { status: "guaranteed" },
  transaction: { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": { status: "guaranteed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.stream": { status: "guaranteed" },
  "statement.cancel": { status: "guarded", conditionCode: "mysql2.physical-connection-destroy" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["number", "string"] },
  "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "data.json-parsed": { status: "unsupported", rawRepresentations: ["object", "array", "string", "number", "boolean", "null"], conditionCode: "mysql2.json-strings" },
  "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-lossless": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-native": { status: "unsupported", rawRepresentations: ["Date", "string"], conditionCode: "mysql2.date-strings" },
};

export const MYSQL2_EXPECTED_TRANSACTION_OPTIONS: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "guaranteed",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "guaranteed",
  "combination:read-uncommitted+readWrite": "guaranteed",
  "combination:read-committed+readOnly": "guaranteed",
  "combination:read-committed+readWrite": "guaranteed",
  "combination:repeatable-read+readOnly": "guaranteed",
  "combination:repeatable-read+readWrite": "guaranteed",
  "combination:serializable+readOnly": "guaranteed",
  "combination:serializable+readWrite": "guaranteed",
};

export const MARIADB_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guarded", canonical: "string", rawRepresentations: ["number", "string", "bigint"], conditionCode: "mariadb.exact-numeric-profile" },
  "numeric.exact-decimal": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "mariadb.exact-numeric-profile" },
  "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "data.json-lossless-text": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "mariadb.auto-json-map-false" },
  "data.json-parsed": { status: "guarded", rawRepresentations: ["object", "array", "string", "number", "boolean", "null"], conditionCode: "mariadb.auto-json-map-true" },
  "data.temporal-lossless": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "mariadb.date-strings-true" },
  "data.temporal-native": { status: "guarded", rawRepresentations: ["Date"], conditionCode: "mariadb.date-strings-false" },
  "metadata.command-safe": { status: "guarded", canonical: "number", rawRepresentations: ["number", "bigint", "string"], conditionCode: "mariadb.safe-command-count" },
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": { status: "guaranteed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guarded", conditionCode: "mariadb.connection-destroy" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
  "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
};

export const MARIADB_EXPECTED_TRANSACTION_OPTIONS: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "guaranteed",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "guaranteed",
  "combination:read-uncommitted+readWrite": "guaranteed",
  "combination:read-committed+readOnly": "guaranteed",
  "combination:read-committed+readWrite": "guaranteed",
  "combination:repeatable-read+readOnly": "guaranteed",
  "combination:repeatable-read+readWrite": "guaranteed",
  "combination:serializable+readOnly": "guaranteed",
  "combination:serializable+readWrite": "guaranteed",
};

export const ORACLE_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "unsupported", canonical: "string", rawRepresentations: ["string"] },
  "numeric.exact-decimal": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "numeric.approximate-special": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "numeric.bind-exact": { status: "unsupported", conditionCode: "oracle.bind-nls-sensitive" },
  "data.json-parsed": { status: "guaranteed", rawRepresentations: ["object", "array", "string", "number", "boolean", "null"] },
  "data.json-lossless-text": { status: "unsupported", canonical: "string", rawRepresentations: ["string"], conditionCode: "oracle.json-serialize-required" },
  "data.oracle-object": { status: "unsupported", rawRepresentations: ["object"], conditionCode: "oracle.object-nested-numeric-unclassified" },
  "data.oracle-collection": { status: "unsupported", rawRepresentations: ["object", "array"], conditionCode: "oracle.collection-nested-numeric-unclassified" },
  "data.vector": { status: "unsupported", rawRepresentations: ["object", "array"], conditionCode: "oracle.vector-unclassified" },
  "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
  "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-native": { status: "guarded", rawRepresentations: ["Date"], conditionCode: "oracle.date-millisecond-precision" },
  "data.temporal-lossless": { status: "unsupported", canonical: "string", rawRepresentations: ["string"], conditionCode: "oracle.temporal-text-cast-required" },
  "metadata.command-safe": { status: "guarded", rawRepresentations: ["number"], conditionCode: "oracle.count-safe-integer" },
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "guaranteed" },
  "transaction.isolation.read-uncommitted": { status: "unsupported" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "unsupported" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guarded", conditionCode: "oracle.connection-break" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "guaranteed" },
  "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "guaranteed" },
};

export const ORACLE_EXPECTED_TRANSACTION_OPTIONS: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "unsupported",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "guaranteed",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "unsupported",
};

export const MSSQL_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["number", "string"] },
  "numeric.exact-decimal": { status: "unsupported", canonical: "string", rawRepresentations: ["number"] },
  "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
  "numeric.bind-exact": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "mssql.character-cast-required" },
  "numeric.aggregate": { status: "unsupported", canonical: "string", rawRepresentations: ["number"], conditionCode: "mssql.exact-decimal-text-cast-required" },
  "metadata.command-safe": { status: "guarded", rawRepresentations: ["number"], conditionCode: "mssql.safe-count" },
  "data.json-lossless-text": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.json-parsed": { status: "unsupported" },
  "data.sql-variant": { status: "unsupported", rawRepresentations: ["driver-native"], conditionCode: "mssql.sql-variant-unclassified" },
  "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Buffer"] },
  "data.uuid": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
  "data.temporal-lossless": { status: "unsupported", conditionCode: "mssql.temporal-text-cast-required" },
  "data.temporal-native": { status: "guarded", rawRepresentations: ["Date", "string"], conditionCode: "mssql.temporal-text-cast-required" },
  "session.pinned": { status: "guaranteed" },
  "transaction": { status: "guaranteed" },
  "transaction.savepoint": { status: "guaranteed" },
  "transaction.read-only": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
  "transaction.isolation.read-uncommitted": { status: "guaranteed" },
  "transaction.isolation.read-committed": { status: "guaranteed" },
  "transaction.isolation.repeatable-read": { status: "guaranteed" },
  "transaction.isolation.serializable": { status: "guaranteed" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "guaranteed" },
  "statement.stream": { status: "guaranteed" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "guaranteed" },
  "routine.out": { status: "guaranteed" },
  "routine.inout": { status: "guaranteed" },
  "routine.return-value": { status: "guaranteed" },
  "routine.result-sets": { status: "guaranteed" },
  "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_CURSOR_UNSUPPORTED" },
};

export const MSSQL_EXPECTED_TRANSACTION_OPTIONS: CertificationTarget["expectedTransactionOptions"] = {
  "isolation:read-uncommitted": "guaranteed",
  "isolation:read-committed": "guaranteed",
  "isolation:repeatable-read": "guaranteed",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "unsupported",
};

export const D1_EXPECTED_CAPABILITIES: ExpectedCapabilityContract = {
  "sql.native-transparency": { status: "guaranteed" },
  "numeric.exact-integer": { status: "guarded", canonical: "string", rawRepresentations: ["number"], conditionCode: "cloudflare-d1.safe-integer" },
  "numeric.approximate-float": { status: "guarded", canonical: "number", rawRepresentations: ["number"], conditionCode: "cloudflare-d1.numeric-profile" },
  "numeric.bind-exact": { status: "guarded", canonical: "string", rawRepresentations: ["string"], conditionCode: "cloudflare-d1.safe-integer" },
  "session.pinned": { status: "unsupported", conditionCode: "cloudflare-d1.no-physical-session-pinning" },
  transaction: { status: "unsupported" },
  "transaction.savepoint": { status: "unsupported" },
  "transaction.read-only": { status: "unsupported" },
  "transaction.isolation.read-uncommitted": { status: "unsupported" },
  "transaction.isolation.read-committed": { status: "unsupported" },
  "transaction.isolation.repeatable-read": { status: "unsupported" },
  "transaction.isolation.serializable": { status: "unsupported" },
  "statement.prepare": { status: "guaranteed" },
  "statement.cancel": { status: "unsupported" },
  "statement.stream": { status: "unsupported" },
  "statement.bulk": { status: "guaranteed" },
  "routine.call": { status: "unsupported" },
  "routine.out": { status: "unsupported" },
  "routine.inout": { status: "unsupported" },
  "routine.return-value": { status: "unsupported" },
  "routine.result-sets": { status: "unsupported" },
  "routine.out-cursor": { status: "unsupported" },
};

export const D1_EXPECTED_TRANSACTION_OPTIONS: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported", "isolation:read-committed": "unsupported", "isolation:repeatable-read": "unsupported", "isolation:serializable": "unsupported",
  "readOnly:true": "unsupported", "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported", "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported", "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported", "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported", "combination:serializable+readWrite": "unsupported",
};

const SQLITE_TRANSACTION_OPTION_VALUES: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported",
  "isolation:read-committed": "unsupported",
  "isolation:repeatable-read": "unsupported",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "guaranteed",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "guaranteed",
};

export function SQLITE_TRANSACTION_OPTIONS(): typeof SQLITE_TRANSACTION_OPTION_VALUES {
  return {
    ...SQLITE_TRANSACTION_OPTION_VALUES,
    "readOnly:false": "unsupported",
    "combination:serializable+readWrite": "unsupported",
  };
}

export function LIBSQL_TRANSACTION_OPTIONS(): typeof SQLITE_TRANSACTION_OPTION_VALUES {
  return {
    ...SQLITE_TRANSACTION_OPTION_VALUES,
    "readOnly:false": "guaranteed",
    "isolation:serializable": "unsupported",
    "combination:serializable+readWrite": "unsupported",
  };
}

function sqliteUnsupportedCapabilities(stream: boolean, session: boolean, localReadOnly: boolean): ExpectedCapabilityContract {
  const unsupported = (unsupportedCode: `BRAID_${string}`): { status: "unsupported"; unsupportedCode: `BRAID_${string}` } => ({ status: "unsupported", unsupportedCode });
  return {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "numeric.bind-exact": { status: "guaranteed", canonical: "string", rawRepresentations: ["string", "number", "bigint"] },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["Uint8Array", "ArrayBuffer"] },
    "session.pinned": session ? { status: "guaranteed" } : unsupported("BRAID_SESSION_UNSUPPORTED"),
    "transaction": { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": localReadOnly
      ? { status: "unsupported", conditionCode: "libsql.file-read-only-not-enforced", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" }
      : unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.read-uncommitted": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.read-committed": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.repeatable-read": unsupported("BRAID_TX_OPTION_UNSUPPORTED"),
    "transaction.isolation.serializable": localReadOnly ? unsupported("BRAID_TX_OPTION_UNSUPPORTED") : { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": unsupported("BRAID_CANCEL_UNSUPPORTED"),
    "statement.stream": stream ? { status: "guaranteed" } : unsupported("BRAID_STREAM_UNSUPPORTED"),
    "statement.bulk": { status: "guaranteed" },
    "routine.call": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.out": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
    "routine.inout": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
    "routine.return-value": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.result-sets": unsupported("BRAID_CALL_UNSUPPORTED"),
    "routine.out-cursor": unsupported("BRAID_CALL_OUT_UNSUPPORTED"),
  };
}

export function SQLITE_EXPECTED_CAPABILITIES(): ExpectedCapabilityContract {
  return sqliteUnsupportedCapabilities(true, true, false);
}

export function LIBSQL_EXPECTED_CAPABILITIES(): ExpectedCapabilityContract {
  return {
    ...sqliteUnsupportedCapabilities(false, false, true),
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["string"] },
    "data.binary": { status: "guaranteed", canonical: "Uint8Array", rawRepresentations: ["ArrayBuffer", "Uint8Array"] },
    "session.pinned": { status: "unsupported", conditionCode: "libsql.client-no-session-pinning", unsupportedCode: "BRAID_SESSION_UNSUPPORTED" },
  };
}

export function WASM_EXPECTED_CAPABILITIES(): ExpectedCapabilityContract {
  return {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": { status: "guaranteed", canonical: "string", rawRepresentations: ["bigint", "string"] },
    "numeric.approximate-float": { status: "guaranteed", canonical: "number", rawRepresentations: ["number"] },
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
    "transaction.read-only": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.read-uncommitted": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.read-committed": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.repeatable-read": { status: "unsupported", unsupportedCode: "BRAID_TX_OPTION_UNSUPPORTED" },
    "transaction.isolation.serializable": { status: "guaranteed" },
    "statement.prepare": { status: "guaranteed" },
    "statement.stream": { status: "guaranteed" },
    "statement.cancel": { status: "unsupported", unsupportedCode: "BRAID_CANCEL_UNSUPPORTED" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "unsupported", unsupportedCode: "BRAID_CALL_UNSUPPORTED" },
    "routine.out": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
    "routine.inout": { status: "unsupported", unsupportedCode: "BRAID_CALL_OUT_UNSUPPORTED" },
    "routine.result-sets": { status: "unsupported", unsupportedCode: "BRAID_CALL_RESULT_SETS" },
    "routine.out-cursor": { status: "unsupported", unsupportedCode: "BRAID_CALL_CURSOR_UNSUPPORTED" },
    "routine.return-value": { status: "unsupported", unsupportedCode: "BRAID_CALL_RETURN_UNSUPPORTED" },
  };
};

export const WASM_EXPECTED_TRANSACTION_OPTIONS: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> = {
  "isolation:read-uncommitted": "unsupported",
  "isolation:read-committed": "unsupported",
  "isolation:repeatable-read": "unsupported",
  "isolation:serializable": "guaranteed",
  "readOnly:true": "unsupported",
  "readOnly:false": "unsupported",
  "combination:read-uncommitted+readOnly": "unsupported",
  "combination:read-uncommitted+readWrite": "unsupported",
  "combination:read-committed+readOnly": "unsupported",
  "combination:read-committed+readWrite": "unsupported",
  "combination:repeatable-read+readOnly": "unsupported",
  "combination:repeatable-read+readWrite": "unsupported",
  "combination:serializable+readOnly": "unsupported",
  "combination:serializable+readWrite": "unsupported",
};

const OPTION_KEYS: readonly TransactionOptionKey[] = [
  "isolation:read-uncommitted", "isolation:read-committed", "isolation:repeatable-read", "isolation:serializable",
  "readOnly:true", "readOnly:false",
  "combination:read-uncommitted+readOnly", "combination:read-uncommitted+readWrite",
  "combination:read-committed+readOnly", "combination:read-committed+readWrite",
  "combination:repeatable-read+readOnly", "combination:repeatable-read+readWrite",
  "combination:serializable+readOnly", "combination:serializable+readWrite",
];
function capability(status: ExpectedCapability["status"], fields: Partial<ExpectedCapability> = {}): ExpectedCapability {
  return Object.freeze({ status, ...fields });
}

export function BUN_EXPECTED_CAPABILITIES(dialect: BunSqlDialect): ExpectedCapabilityContract {
  const server = dialect !== "sqlite";
  const mysqlFamily = dialect === "mysql" || dialect === "mariadb";
  const jsonNative = dialect === "postgres" || dialect === "mysql";
  return Object.freeze({
    "sql.native-transparency": capability("guaranteed"),
    "sql.generated-structure": capability("guaranteed"),
    "result.rows": capability(dialect === "postgres" ? "guaranteed" : "guarded", dialect === "postgres" ? {} : { conditionCode: dialect === "sqlite" ? "bun-sql.sqlite-result-parser" : "bun-sql.result-kind-metadata" }),
    "result.command": capability(dialect === "postgres" ? "guaranteed" : "guarded", dialect === "postgres" ? {} : { conditionCode: dialect === "sqlite" ? "bun-sql.sqlite-result-parser" : "bun-sql.result-kind-metadata" }),
    "result.multiple-sets": capability("unsupported"),
    "result.standard-schema": capability("guaranteed"),
    "numeric.exact-integer": capability("guarded", { canonical: "string", rawRepresentations: ["number", "string", "bigint"], conditionCode: "bun-sql.integer-width-profile" }),
    "numeric.exact-decimal": dialect === "postgres" ? capability("guaranteed", { canonical: "string", rawRepresentations: ["string"] }) : capability("unsupported", { canonical: "string", rawRepresentations: [mysqlFamily ? "Uint8Array" : "number"] }),
    "numeric.approximate-float": capability("guarded", { canonical: "number", rawRepresentations: ["number"], conditionCode: "bun-sql.float-profile" }),
    "numeric.approximate-special": mysqlFamily ? capability("unsupported", { canonical: "number", rawRepresentations: ["null", "number"] }) : capability("guarded", { canonical: "number", rawRepresentations: ["number"], conditionCode: "bun-sql.special-float-profile" }),
    "numeric.bind-exact": capability("guarded", { canonical: "string", rawRepresentations: ["string", "number", "bigint"], conditionCode: "bun-sql.numeric-bind-profile" }),
    "numeric.command-metadata": capability("guarded", { canonical: "number", rawRepresentations: ["number", "bigint"], conditionCode: "bun-sql.command-count-profile" }),
    "data.json-parsed": jsonNative ? capability("guarded", { rawRepresentations: ["object", "array"], conditionCode: "bun-sql.json-parser-profile" }) : capability("unsupported", { rawRepresentations: ["string"] }),
    "data.json-lossless-text": jsonNative ? capability("unsupported") : capability("guaranteed", { canonical: "string", rawRepresentations: ["string"] }),
    "data.binary": mysqlFamily ? capability("unsupported", { canonical: "Uint8Array", rawRepresentations: ["Uint8Array"] }) : capability("guaranteed", { canonical: "Uint8Array", rawRepresentations: ["Uint8Array"] }),
    "data.temporal-native": dialect === "sqlite" ? capability("unsupported", { rawRepresentations: ["string"] }) : capability("guarded", { rawRepresentations: ["Date", "string"], conditionCode: "bun-sql.temporal-profile" }),
    "data.temporal-lossless": dialect === "sqlite" ? capability("guaranteed", { canonical: "string", rawRepresentations: ["string"] }) : capability("unsupported"),
    "data.timezone": dialect === "sqlite" ? capability("unsupported", { rawRepresentations: ["string"] }) : capability("guarded", { rawRepresentations: ["Date"], conditionCode: "bun-sql.timezone-profile" }),
    "metadata.command-safe": capability("guarded", { canonical: "number", rawRepresentations: ["number", "bigint"], conditionCode: "bun-sql.command-count-profile" }),
    "dml.insert-returning": server && dialect !== "postgres" && dialect !== "mariadb" ? capability("unsupported") : capability("guaranteed"),
    "dml.update-returning": server && dialect !== "postgres" ? capability("unsupported") : capability("guaranteed"),
    "dml.delete-returning": server && dialect !== "postgres" && dialect !== "mariadb" ? capability("unsupported") : capability("guaranteed"),
    "session.pinned": capability("guaranteed"),
    "statement.prepare": capability("guaranteed"),
    "statement.cancel": capability("unsupported", { rawRepresentations: ["Query.cancel"] }),
    "statement.stream": capability("unsupported"),
    "statement.bulk": capability("guaranteed", { rawRepresentations: ["prepared-loop"] }),
    "execution.bulk-fidelity": capability("guarded", { rawRepresentations: ["prepared-loop"], conditionCode: "bun-sql.bulk-profile" }),
    "transaction": capability("guaranteed"),
    "transaction.savepoint": capability("guaranteed"),
    "transaction.read-only": server ? capability("guarded", { conditionCode: "bun-sql.transaction-options" }) : capability("unsupported"),
    "transaction.isolation.read-uncommitted": server ? capability("guarded", { conditionCode: "bun-sql.transaction-options" }) : capability("unsupported"),
    "transaction.isolation.read-committed": server ? capability("guarded", { conditionCode: "bun-sql.transaction-options" }) : capability("unsupported"),
    "transaction.isolation.repeatable-read": server ? capability("guarded", { conditionCode: "bun-sql.transaction-options" }) : capability("unsupported"),
    "transaction.isolation.serializable": server ? capability("guarded", { conditionCode: "bun-sql.transaction-options" }) : capability("guaranteed"),
    "routine.call": capability("unsupported"),
    "routine.out": capability("unsupported"),
    "routine.inout": capability("unsupported"),
    "routine.result-sets": capability("unsupported"),
    "routine.out-cursor": capability("unsupported"),
    "routine.return-value": capability("unsupported"),
  });
}

export function BUN_EXPECTED_TRANSACTION_OPTIONS(dialect: BunSqlDialect): Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">> {
  return Object.freeze(Object.fromEntries(OPTION_KEYS.map((key) => [key, dialect === "sqlite" && key !== "isolation:serializable" ? "unsupported" : "guaranteed"]))) as Record<TransactionOptionKey, "guaranteed" | "unsupported">;
}

export function BUN_EXPECTED_GUARDED_CASES(dialect: BunSqlDialect): ExpectedGuardedCaseContract | undefined {
  return dialect === "mysql" || dialect === "mariadb"
    ? { emptyResultError: { feature: "result.rows", code: "BRAID_RESULT_KIND_AMBIGUOUS" } }
    : undefined;
};

export const CERTIFICATION_TARGET_TUPLES: Readonly<Record<string, CertificationTuple>> = {
  "postgres-pg-node-16-4": { database: { product: "postgres", version: "16.4", edition: "alpine", versionStatus: "measured" }, driver: { id: "pg", package: "@sqlbraid/postgres", version: "8.23.0", profile: "pg-lossless-text" }, runtime: { id: "node", version: "22.18.0" } },
  "postgres-current": { database: { product: "postgres", version: "18.6", edition: "alpine", versionStatus: "measured" }, driver: { id: "pg", package: "@sqlbraid/postgres", version: "8.23.0", profile: "pg-lossless-text" }, runtime: { id: "node", version: "22.18.0" } },
  "postgres-pg-deno-2-9-3": { database: { product: "postgres", version: "16.4", edition: "alpine", versionStatus: "measured" }, driver: { id: "pg", package: "@sqlbraid/postgres", version: "8.23.0", profile: "pg-lossless-text" }, runtime: { id: "deno", version: "2.9.3" } },
  "mysql-mysql2-node-8-4-2": { database: { product: "mysql", version: "8.4.2", edition: "community", versionStatus: "measured" }, driver: { id: "mysql2", package: "@sqlbraid/mysql", version: "3.24.4", profile: "mysql2-lossless-text" }, runtime: { id: "node", version: "22.18.0" } },
  "mysql-mysql2-deno-2-9-3": { database: { product: "mysql", version: "8.4.2", edition: "community", versionStatus: "measured" }, driver: { id: "mysql2", package: "@sqlbraid/mysql", version: "3.24.4", profile: "mysql2-lossless-text" }, runtime: { id: "deno", version: "2.9.3" } },
  "mariadb-connector-node-11-8-9": { database: { product: "mariadb", version: "11.8.9", edition: "community", versionStatus: "measured" }, driver: { id: "mariadb", package: "@sqlbraid/mariadb", version: "3.5.4", profile: "mariadb-lossless-text" }, runtime: { id: "node", version: "22.18.0" } },
  "oracle-oracledb-thin-node-23-9": { database: { product: "oracle", version: "23.9", edition: "Free", versionStatus: "measured" }, driver: { id: "node-oracledb", package: "@sqlbraid/oracle", version: "7.0.1", profile: "oracle-thin" }, runtime: { id: "node", version: "22.18.0" } },
  "mssql-tedious-developer-node-2022-cu18": { database: { product: "mssql", version: "2022-CU18", edition: "Developer", versionStatus: "measured" }, driver: { id: "tedious", package: "@sqlbraid/mssql", version: "20.0.0", profile: "mssql-tedious" }, runtime: { id: "node", version: "22.18.0" } },
  "sqlite-node-sqlite-node-22-18-0": { database: { product: "sqlite", version: "3.50.2", edition: "Node bundled SQLite", versionStatus: "measured" }, driver: { id: "node-sqlite", package: "@sqlbraid/sqlite/node-sqlite", version: "22.18.0", profile: "sqlite-exact-string" }, runtime: { id: "node", version: "22.18.0" } },
  "sqlite-node-sqlite-deno-2-9-3": { database: { product: "sqlite", version: "3.53.2", edition: "Deno bundled SQLite", versionStatus: "measured" }, driver: { id: "node-sqlite", package: "@sqlbraid/sqlite/node-sqlite", version: "2.9.3", profile: "sqlite-exact-string" }, runtime: { id: "deno", version: "2.9.3" } },
  "better-sqlite3-node-22-18-0": { database: { product: "sqlite", edition: "better-sqlite3 bundled SQLite", versionStatus: "unknown" }, driver: { id: "better-sqlite3", package: "@sqlbraid/sqlite/better-sqlite3", version: "13.0.3", profile: "better-sqlite3-exact-string" }, runtime: { id: "node", version: "22.18.0" } },
  "libsql-local-node-22-18-0": { database: { product: "sqlite", edition: "libSQL local SQLite", versionStatus: "unknown" }, driver: { id: "libsql", package: "@sqlbraid/sqlite/libsql", version: "0.18.0", profile: "libsql-exact-string" }, runtime: { id: "node", version: "22.18.0" } },
  "bun-sql-postgres": { database: { product: "postgres", version: "16.4", edition: "alpine", versionStatus: "measured" }, driver: { id: "bun-sql", package: "@sqlbraid/bun-sql", version: "1.3.14", profile: "bun-sql-postgres-1.3.14" }, runtime: { id: "bun", version: "1.3.14" } },
  "bun-sql-mysql": { database: { product: "mysql", version: "8.4.2", edition: "community", versionStatus: "measured" }, driver: { id: "bun-sql", package: "@sqlbraid/bun-sql", version: "1.3.14", profile: "bun-sql-mysql-1.3.14" }, runtime: { id: "bun", version: "1.3.14" } },
  "bun-sql-mariadb": { database: { product: "mariadb", version: "11.8.9", edition: "community", versionStatus: "measured" }, driver: { id: "bun-sql", package: "@sqlbraid/bun-sql", version: "1.3.14", profile: "bun-sql-mariadb-1.3.14" }, runtime: { id: "bun", version: "1.3.14" } },
  "bun-sql-sqlite": { database: { product: "sqlite", version: "3.53.0", edition: "bun-embedded", versionStatus: "measured" }, driver: { id: "bun-sql", package: "@sqlbraid/bun-sql", version: "1.3.14", profile: "bun-sql-sqlite-1.3.14" }, runtime: { id: "bun", version: "1.3.14" } },
  "d1-cloudflare-workerd-2026-07-30": { database: { product: "sqlite", edition: "Cloudflare D1 managed SQLite", versionStatus: "unknown" }, driver: { id: "cloudflare-d1", package: "@sqlbraid/sqlite/d1", version: "1.20260730.1", profile: "d1-guarded-safe-integer" }, runtime: { id: "workerd", version: "1.20260730.1" } },
  "sqlite-wasm-browser-3-53-4": { database: { product: "sqlite", version: "3.53.4", edition: "official SQLite WASM OO1", versionStatus: "measured" }, driver: { id: "sqlite-wasm", package: "@sqlbraid/sqlite/wasm", version: "3.53.4-build1", profile: "sqlite-wasm-exact-string" }, runtime: { id: "browser", version: "153.0.8010.12" } },
};

export interface CertificationTargetContract {
  readonly expectedCapabilities: ExpectedCapabilityContract;
  readonly expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">>;
  readonly expectedGuardedCases?: ExpectedGuardedCaseContract;
  readonly tuple: CertificationTuple;
};

export const CERTIFICATION_CONTRACTS: Readonly<Record<string, CertificationTargetContract>> = {
  "postgres-pg-node-16-4": { expectedCapabilities: POSTGRES_EXPECTED_CAPABILITIES, expectedTransactionOptions: POSTGRES_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["postgres-pg-node-16-4"] },
  "postgres-current": { expectedCapabilities: POSTGRES_EXPECTED_CAPABILITIES, expectedTransactionOptions: POSTGRES_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["postgres-current"] },
  "postgres-pg-deno-2-9-3": { expectedCapabilities: POSTGRES_EXPECTED_CAPABILITIES, expectedTransactionOptions: POSTGRES_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["postgres-pg-deno-2-9-3"] },
  "mysql-mysql2-node-8-4-2": { expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES, expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["mysql-mysql2-node-8-4-2"] },
  "mysql-mysql2-deno-2-9-3": { expectedCapabilities: MYSQL2_EXPECTED_CAPABILITIES, expectedTransactionOptions: MYSQL2_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["mysql-mysql2-deno-2-9-3"] },
  "mariadb-connector-node-11-8-9": { expectedCapabilities: MARIADB_EXPECTED_CAPABILITIES, expectedTransactionOptions: MARIADB_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["mariadb-connector-node-11-8-9"] },
  "oracle-oracledb-thin-node-23-9": { expectedCapabilities: ORACLE_EXPECTED_CAPABILITIES, expectedTransactionOptions: ORACLE_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["oracle-oracledb-thin-node-23-9"] },
  "mssql-tedious-developer-node-2022-cu18": { expectedCapabilities: MSSQL_EXPECTED_CAPABILITIES, expectedTransactionOptions: MSSQL_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["mssql-tedious-developer-node-2022-cu18"] },
  "sqlite-node-sqlite-node-22-18-0": { expectedCapabilities: SQLITE_EXPECTED_CAPABILITIES(), expectedTransactionOptions: SQLITE_TRANSACTION_OPTIONS(), tuple: CERTIFICATION_TARGET_TUPLES["sqlite-node-sqlite-node-22-18-0"] },
  "sqlite-node-sqlite-deno-2-9-3": { expectedCapabilities: SQLITE_EXPECTED_CAPABILITIES(), expectedTransactionOptions: SQLITE_TRANSACTION_OPTIONS(), tuple: CERTIFICATION_TARGET_TUPLES["sqlite-node-sqlite-deno-2-9-3"] },
  "better-sqlite3-node-22-18-0": { expectedCapabilities: SQLITE_EXPECTED_CAPABILITIES(), expectedTransactionOptions: SQLITE_TRANSACTION_OPTIONS(), tuple: CERTIFICATION_TARGET_TUPLES["better-sqlite3-node-22-18-0"] },
  "libsql-local-node-22-18-0": { expectedCapabilities: LIBSQL_EXPECTED_CAPABILITIES(), expectedTransactionOptions: LIBSQL_TRANSACTION_OPTIONS(), tuple: CERTIFICATION_TARGET_TUPLES["libsql-local-node-22-18-0"] },
  "bun-sql-postgres": { expectedCapabilities: BUN_EXPECTED_CAPABILITIES("postgres"), expectedTransactionOptions: BUN_EXPECTED_TRANSACTION_OPTIONS("postgres"), expectedGuardedCases: BUN_EXPECTED_GUARDED_CASES("postgres"), tuple: CERTIFICATION_TARGET_TUPLES["bun-sql-postgres"] },
  "bun-sql-mysql": { expectedCapabilities: BUN_EXPECTED_CAPABILITIES("mysql"), expectedTransactionOptions: BUN_EXPECTED_TRANSACTION_OPTIONS("mysql"), expectedGuardedCases: BUN_EXPECTED_GUARDED_CASES("mysql"), tuple: CERTIFICATION_TARGET_TUPLES["bun-sql-mysql"] },
  "bun-sql-mariadb": { expectedCapabilities: BUN_EXPECTED_CAPABILITIES("mariadb"), expectedTransactionOptions: BUN_EXPECTED_TRANSACTION_OPTIONS("mariadb"), expectedGuardedCases: BUN_EXPECTED_GUARDED_CASES("mariadb"), tuple: CERTIFICATION_TARGET_TUPLES["bun-sql-mariadb"] },
  "bun-sql-sqlite": { expectedCapabilities: BUN_EXPECTED_CAPABILITIES("sqlite"), expectedTransactionOptions: BUN_EXPECTED_TRANSACTION_OPTIONS("sqlite"), expectedGuardedCases: BUN_EXPECTED_GUARDED_CASES("sqlite"), tuple: CERTIFICATION_TARGET_TUPLES["bun-sql-sqlite"] },
  "d1-cloudflare-workerd-2026-07-30": { expectedCapabilities: D1_EXPECTED_CAPABILITIES, expectedTransactionOptions: D1_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["d1-cloudflare-workerd-2026-07-30"] },
  "sqlite-wasm-browser-3-53-4": { expectedCapabilities: WASM_EXPECTED_CAPABILITIES(), expectedTransactionOptions: WASM_EXPECTED_TRANSACTION_OPTIONS, tuple: CERTIFICATION_TARGET_TUPLES["sqlite-wasm-browser-3-53-4"] },
};

export function certificationContract(target: string): CertificationTargetContract {
  const contract = CERTIFICATION_CONTRACTS[target];
  if (!contract) throw new Error(`Unknown certification contract: ${target}`);
  return contract;
}
