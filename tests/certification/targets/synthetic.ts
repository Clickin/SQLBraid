import {
  UnsupportedFeatureError,
  createBulkBindingDescription,
  createStatementBindingDescription,
  type CallQuery,
  type CommandQuery,
  type DatabaseEnvironment,
  type DriverRoutineResult,
  type ExecutionOptions,
  type QueryExecutor,
  type QueryExecutionResult,
  type QueryResultKind,
  type RenderedBulk,
  type RenderedStatement,
  type RowQuery,
  type StandardSchemaV1,
  type StatementBindingContext,
  type StatementBindingDescription,
} from "@sqlbraid/core";
import assert from "node:assert/strict";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot } from "../types.js";

type Marker = "zero" | "one" | "many" | "command" | "identity" | "failure" | "stream" | "stream-init" | "stream-first" | "stream-mid" | "stream-cleanup" | "large" | "special" | "insert" | "savepoint-insert" | "transaction-visible" | "call";
type Definition = { readonly marker: Marker; readonly rows?: readonly unknown[]; readonly value?: unknown; readonly failure?: unknown; readonly cleanup?: Error };

interface SyntheticState {
  committedRows: number;
  sideEffects: number;
  cleanupBalance: number;
  identity: string;
  bulkCalls: number;
  bulkExec: number;
  streamReturns: number;
  preparedCalls: number;
  pending: number[];
  savepoints: Map<string, number>;
  borrowed: number;
}

export interface SyntheticTargetOptions {
  readonly resultRowsGuarded?: boolean;
  readonly resultSetsUnsupported?: boolean;
}

const CAPABILITY_KEYS = [
  "session.pinned", "transaction", "transaction.savepoint", "transaction.read-only",
  "transaction.isolation.read-uncommitted", "transaction.isolation.read-committed",
  "transaction.isolation.repeatable-read", "transaction.isolation.serializable",
  "statement.prepare", "statement.stream", "statement.cancel", "statement.bulk",
  "routine.call", "routine.out", "routine.inout", "routine.result-sets", "routine.out-cursor", "routine.return-value",
] as const;

const statementBinding = Object.freeze({
  id: "certification-runtime-executor",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    return createStatementBindingDescription(statement, context, {
      adapterId: "certification-runtime-executor",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext) {
    return createBulkBindingDescription(bulk, context, {
      adapterId: "certification-runtime-executor",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
  },
});

const syntheticEnvironment: DatabaseEnvironment = {
  database: { product: "synthetic-runtime", version: "1", edition: "memory" },
  driver: { id: "certification-runtime-executor", version: "1", profile: "deterministic" },
  runtime: { id: "node", version: process.versions.node },
  capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { status: "guaranteed" }])) as DatabaseEnvironment["capabilities"],
  supportMatch: { status: "compatible", targetId: "certification-runtime-executor" },
};

function markerOf(rendered: RenderedStatement): string {
  const parameter = rendered.parameters[0]?.value;
  if (typeof parameter === "string") return parameter;
  return rendered.segments.join("").replace(/^CERT:/u, "");
}

function rowQuery(
  marker: Marker,
  definitions: Map<string, Definition>,
  rows: readonly unknown[],
  options: { readonly resultSchema?: StandardSchemaV1<unknown, unknown>; readonly failure?: unknown; readonly cleanup?: Error } = {},
): RowQuery<unknown> {
  const key = `row-${marker}-${definitions.size}`;
  definitions.set(key, { marker, rows, failure: options.failure, cleanup: options.cleanup });
  return options.resultSchema === undefined ? sql.rows`SELECT ${key}` : sql.rows(options.resultSchema)`SELECT ${key}`;
}

function commandQuery(marker: Marker, definitions: Map<string, Definition>): CommandQuery {
  const key = `command-${marker}-${definitions.size}`;
  definitions.set(key, { marker });
  return sql.command`UPDATE certification SET marker = ${key}`;
}

function callQuery(definitions: Map<string, Definition>, value: unknown): CallQuery {
  const key = `call-${definitions.size}`;
  definitions.set(key, { marker: "call", value });
  return sql.call`CALL certification_${key}()`;
}

function specialRow(definitions: Map<string, Definition>, label: string, value: unknown): RowQuery<unknown> {
  const row = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(row, label, { value, enumerable: true, writable: true, configurable: true });
  return rowQuery("special", definitions, [row]);
}

function expectedSpecialRow(label: string, value: unknown): Record<string, unknown> {
  const row = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(row, label, { value, enumerable: true, writable: true, configurable: true });
  return row;
}

function optionKey(options: { readonly isolation?: string; readonly readOnly?: boolean }): string {
  if (options.isolation !== undefined && options.readOnly !== undefined) return `combination:${options.isolation}+${options.readOnly ? "readOnly" : "readWrite"}`;
  if (options.isolation !== undefined) return `isolation:${options.isolation}`;
  return `readOnly:${options.readOnly === true ? "true" : "false"}`;
}

function createExecutor(state: SyntheticState, definitions: Map<string, Definition>, cancelUnsupported: boolean, environmentValue: DatabaseEnvironment, options: SyntheticTargetOptions): QueryExecutor {
  const definitionFor = (rendered: RenderedStatement): Definition => {
    const definition = definitions.get(markerOf(rendered));
    if (!definition) throw new Error(`Unknown certification marker ${markerOf(rendered)}.`);
    return definition;
  };
  const command = (definition: Definition): { readonly kind: "command"; readonly rows: readonly unknown[]; readonly rowCount: number; readonly command: { readonly affectedRows: number } } => {
    if (definition.marker === "insert" || definition.marker === "savepoint-insert") {
      const pending = state.pending.at(-1);
      if (pending === undefined) state.committedRows += 1;
      else state.pending[state.pending.length - 1] = pending + 1;
      state.sideEffects += 1;
    }
    return { kind: "command", rows: [], rowCount: 1, command: { affectedRows: 1 } };
  };
  return {
    statementBinding,
    environment: environmentValue,
    async query<Row>(rendered: RenderedStatement): Promise<QueryExecutionResult<Row>> {
      const definition = definitionFor(rendered);
      if (definition.marker === "failure") throw Object.assign(new Error("synthetic driver failure"), { code: "SYNTHETIC_QUERY_FAILURE" });
      if (rendered.resultKind === "command") return command(definition) as QueryExecutionResult<Row>;
      if (definition.marker === "transaction-visible") {
        const visible = state.committedRows + state.pending.reduce((sum, value) => sum + value, 0);
        if (options.resultRowsGuarded && visible === 0) throw new UnsupportedFeatureError("result.rows", "BRAID_RESULT_KIND_AMBIGUOUS", "synthetic empty result kind is ambiguous");
        return { kind: "rows", rows: (visible > 0 ? [{ value: 1 }] : []) as unknown as readonly Row[], rowCount: visible > 0 ? 1 : 0 };
      }
      const rows = definition.marker === "zero" ? [] : definition.marker === "one" ? [{ value: "one" }] : definition.marker === "identity" ? [{ id: state.identity }] : definition.rows ?? [];
      if (options.resultRowsGuarded && rows.length === 0 && definition.marker === "zero") throw new UnsupportedFeatureError("result.rows", "BRAID_RESULT_KIND_AMBIGUOUS", "synthetic empty result kind is ambiguous");
      return { kind: "rows", rows: rows as readonly Row[], rowCount: rows.length };
    },
    stream<Row>(rendered: RenderedStatement, _binding?: StatementBindingDescription, options?: ExecutionOptions): AsyncIterable<Row> {
      const definition = definitionFor(rendered);
      const values = definition.rows ?? [];
      return {
        async *[Symbol.asyncIterator]() {
          if (options?.signal?.aborted) throw options.signal.reason;
          if (definition.marker === "stream-init") throw definition.failure ?? new Error("synthetic iterator init failure");
          try {
            for (let index = 0; index < values.length; index += 1) {
              if (options?.signal?.aborted) throw options.signal.reason;
              if (definition.marker === "stream-first" && index === 0) throw definition.failure ?? new Error("synthetic first next failure");
              if (definition.marker === "stream-mid" && index === 1) throw definition.failure ?? new Error("synthetic mid-stream failure");
              yield values[index] as Row;
            }
          } finally {
            state.streamReturns += 1;
            if (definition.marker === "stream-cleanup") throw definition.cleanup ?? new Error("synthetic cleanup failure");
          }
        },
      };
    },
    async call(rendered: RenderedStatement): Promise<DriverRoutineResult> {
      const value = (definitionFor(rendered).value ?? {}) as { readonly output?: unknown; readonly resultSets?: readonly unknown[]; readonly returnValue?: unknown };
      if (options.resultSetsUnsupported && value.resultSets !== undefined) throw new UnsupportedFeatureError("routine.result-sets", "BRAID_RESULT_SETS_UNSUPPORTED", "synthetic multiple result sets unsupported");
      const resultSets = value.resultSets?.map((rows, index) => ({ rows, source: { kind: "emitted" as const, index } })) ?? [];
      return { output: value.output ?? {}, resultSets, ...(value.returnValue === undefined ? {} : { returnValue: value.returnValue }) } as unknown as DriverRoutineResult;
    },
    async bulk(bulk): Promise<{ readonly inputCount: number; readonly affectedRows: number; readonly executionMode: "native-bulk" }> {
      state.bulkCalls += 1;
      state.bulkExec += 1;
      return { inputCount: bulk.parameterSets.length, affectedRows: bulk.parameterSets.length, executionMode: "native-bulk" };
    },
    async begin(options) {
      if (options && optionKey(options) === "combination:serializable+readOnly") throw new UnsupportedFeatureError("transaction.isolation.serializable", "BRAID_TX_OPTION_UNSUPPORTED", "synthetic option combination unsupported");
      state.pending.push(0);
    },
    async commit() {
      const value = state.pending.pop() ?? 0;
      if (state.pending.length === 0) state.committedRows += value;
      else state.pending[state.pending.length - 1] += value;
    },
    async rollback() { state.pending.pop(); },
    async savepoint(name: string) { state.savepoints.set(name, state.pending.at(-1) ?? 0); },
    async rollbackTo(name: string) { const value = state.savepoints.get(name); if (value !== undefined && state.pending.length > 0) state.pending[state.pending.length - 1] = value; },
    async releaseSavepoint(name: string) { state.savepoints.delete(name); },
    ...(cancelUnsupported ? { cancel: async () => { throw new UnsupportedFeatureError("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "synthetic cancellation unsupported"); } } : {}),
  };
}

function makeQueries(definitions: Map<string, Definition>, options: SyntheticTargetOptions) {
  const specialValues: Record<string, unknown> = {
    RES001: "safe", RES002: "safe", RES003: "safe", RES004: "safe", RES005: "safe",
    RES006: "hello", RES007: "", RES008: null, RES009: "안녕하세요", RES010: new Uint8Array([0, 255, 16]), RES011: "second",
  };
  const special = {
    RES001: specialRow(definitions, "__proto__", specialValues.RES001), RES002: specialRow(definitions, "constructor", specialValues.RES002),
    RES003: specialRow(definitions, "prototype", specialValues.RES003), RES004: specialRow(definitions, "toString", specialValues.RES004), RES005: specialRow(definitions, "hasOwnProperty", specialValues.RES005),
    RES006: rowQuery("special", definitions, [specialValues.RES006]), RES007: rowQuery("special", definitions, [specialValues.RES007]), RES008: rowQuery("special", definitions, [specialValues.RES008]), RES009: rowQuery("special", definitions, [specialValues.RES009]), RES010: rowQuery("special", definitions, [specialValues.RES010]), RES011: rowQuery("special", definitions, [{ value: specialValues.RES011 }]),
  };
  const expectedSpecial = {
    ...specialValues,
    RES001: expectedSpecialRow("__proto__", specialValues.RES001),
    RES002: expectedSpecialRow("constructor", specialValues.RES002),
    RES003: expectedSpecialRow("prototype", specialValues.RES003),
    RES004: expectedSpecialRow("toString", specialValues.RES004),
    RES005: expectedSpecialRow("hasOwnProperty", specialValues.RES005),
    RES011: { value: specialValues.RES011 },
  };
  return {
    zero: rowQuery("zero", definitions, []), one: rowQuery("one", definitions, [{ value: "one" }]), many: rowQuery("many", definitions, [{ value: 1 }, { value: 2 }]), command: commandQuery("command", definitions), identity: rowQuery("identity", definitions, [{ id: "synthetic-session-1" }]), failure: rowQuery("failure", definitions, []), stream: rowQuery("stream", definitions, [{ value: 1 }, { value: 2 }]), special,
    transaction: { insert: commandQuery("insert", definitions), visible: rowQuery("transaction-visible", definitions, []), savepointInsert: commandQuery("savepoint-insert", definitions), savepointVisible: rowQuery("transaction-visible", definitions, []) },
    routines: { call: callQuery(definitions, { output: { answer: 42 } }), out: callQuery(definitions, { output: { answer: 42 } }), inout: callQuery(definitions, { output: { answer: 43 } }), resultSets: callQuery(definitions, { resultSets: [[{ value: 1 }], [{ value: 2 }]] }), cursor: callQuery(definitions, { resultSets: [[{ value: 1 }]] }), returnValue: callQuery(definitions, { returnValue: 7 }) },
    expected: { one: { value: "one" }, many: [{ value: 1 }, { value: 2 }], special: { ...expectedSpecial, CALL001: { output: { answer: 42 }, resultSets: [] }, CALL002: { output: { answer: 42 }, resultSets: [] }, CALL003: { output: { answer: 43 }, resultSets: [] }, CALL004: { output: {}, resultSets: [{ rows: [{ value: 1 }] }, { rows: [{ value: 2 }] }] }, CALL005: { output: {}, resultSets: [{ rows: [{ value: 1 }] }] }, CALL006: { returnValue: 7, output: {}, resultSets: [] } }, commandAffectedRows: 1, failureCode: "SYNTHETIC_QUERY_FAILURE", ...(options.resultRowsGuarded ? { emptyResultError: { feature: "result.rows", code: "BRAID_RESULT_KIND_AMBIGUOUS" as const } } : {}) },
  };
}

export function syntheticExpectedCapabilities(cancelUnsupported = false, options: SyntheticTargetOptions = {}): ExpectedCapabilityContract {
  const capabilities: Record<string, Record<string, string>> = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { status: cancelUnsupported && key === "statement.cancel" ? "unsupported" : options.resultSetsUnsupported && key === "routine.result-sets" ? "unsupported" : "guaranteed", ...(cancelUnsupported && key === "statement.cancel" ? { unsupportedCode: "BRAID_CANCEL_UNSUPPORTED" } : options.resultSetsUnsupported && key === "routine.result-sets" ? { unsupportedCode: "BRAID_RESULT_SETS_UNSUPPORTED" } : {}) }]));
  if (options.resultRowsGuarded) {
    capabilities["result.rows"] = { status: "guarded", conditionCode: "synthetic.result-kind-metadata" };
    capabilities["result.multiple-sets"] = { status: options.resultSetsUnsupported ? "unsupported" : "guaranteed" };
  }
  return capabilities as unknown as ExpectedCapabilityContract;
}

export function createSyntheticTarget(sourceSha = "synthetic-source-sha", cancelUnsupported = true, options: SyntheticTargetOptions = {}): CertificationTarget {
  const expectedCapabilities = syntheticExpectedCapabilities(cancelUnsupported, options);
  const environment = { ...syntheticEnvironment, capabilities: Object.fromEntries(Object.entries(expectedCapabilities).map(([key, value]) => [key, { status: value.status, ...(value.conditionCode === undefined ? {} : { conditionCode: value.conditionCode }) }])) as DatabaseEnvironment["capabilities"] };
  const expectedTransactionOptions = { "isolation:read-uncommitted": "guaranteed", "isolation:read-committed": "guaranteed", "isolation:repeatable-read": "guaranteed", "isolation:serializable": "guaranteed", "readOnly:true": "guaranteed", "readOnly:false": "guaranteed", "combination:read-uncommitted+readOnly": "guaranteed", "combination:read-uncommitted+readWrite": "guaranteed", "combination:read-committed+readOnly": "guaranteed", "combination:read-committed+readWrite": "guaranteed", "combination:repeatable-read+readOnly": "guaranteed", "combination:repeatable-read+readWrite": "guaranteed", "combination:serializable+readOnly": "unsupported", "combination:serializable+readWrite": "guaranteed" } as const;
  return {
    id: cancelUnsupported ? "synthetic-runtime-unsupported" : "synthetic-runtime",
    sourceSha,
    expectedCapabilities,
    expectedTransactionOptions,
    ...(options.resultRowsGuarded ? { expectedGuardedCases: { emptyResultError: { feature: "result.rows", code: "BRAID_RESULT_KIND_AMBIGUOUS" as const } } } : {}),
    createFixture: async () => {
      const state: SyntheticState = { committedRows: 0, sideEffects: 0, cleanupBalance: 0, identity: "synthetic-session-1", bulkCalls: 0, bulkExec: 0, streamReturns: 0, preparedCalls: 0, pending: [], savepoints: new Map(), borrowed: 0 };
      const definitions = new Map<string, Definition>();
      const executor = createExecutor(state, definitions, cancelUnsupported, environment, options);
      const db = createDatabase(executor);
      const pooled = createPooledDatabase({ statementBinding, environment, async acquire() { state.borrowed += 1; return { ...executor, release() { state.borrowed -= 1; } }; } });
      const queries = makeQueries(definitions, options) as CertificationFixture["queries"] & { prepared?: CertificationFixture["queries"]["prepared"] };
      queries.prepared = { command: () => { state.preparedCalls += 1; return commandQuery("command", definitions); }, rows: () => { state.preparedCalls += 1; return rowQuery("many", definitions, [{ value: 1 }, { value: 2 }]); }, input: "input", factoryCalls: () => state.preparedCalls, resources: () => 0 };
      const guarded = options.resultRowsGuarded ? { "result.rows": { prove: async () => { assert.deepEqual(await db.all(queries.one), [queries.expected?.one]); } } } : undefined;
      const mappingFailure = new Error("synthetic query-bound mapping failure");
      const executionSchemaFailure = new Error("synthetic execution schema failure");
      const initFailure = new Error("synthetic iterator init failure");
      const firstNextFailure = new Error("synthetic first next failure");
      const midStreamFailure = new Error("synthetic mid-stream failure");
      const cleanupFailure = new Error("synthetic cleanup failure");
      const mappingQuery = rowQuery("stream", definitions, [{ value: 1 }, { value: 2 }], {
        resultSchema: { "~standard": { version: 1, vendor: "certification", validate() { throw mappingFailure; } } },
      });
      const stream = {
        db,
        query: queries.stream!,
        expected: [{ value: 1 }, { value: 2 }],
        mappingQuery,
        mappingFailure,
        executionSchemaFailure,
        initFailureQuery: rowQuery("stream-init", definitions, [], { failure: initFailure }),
        initFailure,
        firstNextFailureQuery: rowQuery("stream-first", definitions, [{ value: 1 }], { failure: firstNextFailure }),
        firstNextFailure,
        midStreamFailureQuery: rowQuery("stream-mid", definitions, [{ value: 1 }, { value: 2 }], { failure: midStreamFailure }),
        midStreamFailure,
        cleanupFailureQuery: rowQuery("stream-cleanup", definitions, [], { cleanup: cleanupFailure }),
        cleanupFailure,
        largeResultQuery: rowQuery("large", definitions, [{ value: 1 }, { value: 2 }, { value: 3 }]),
        largeResultCount: 3,
        iteratorReturns: () => state.streamReturns,
        released: () => state.streamReturns,
      } as StreamingConformanceFixture<unknown>;
      const bulk: BulkConformanceFixture<unknown> = { db, inputs: [1, 2], factory: () => commandQuery("command", definitions), expected: { inputCount: 2, affectedRows: 2 }, acquireCount: () => state.bulkCalls, executeCount: () => state.bulkExec, values: () => [[1], [2]], middleFailure: async () => { throw new Error("synthetic middle failure"); } };
      const fixture: CertificationFixture = { db, pooled, queries, stream, bulk, metrics: { snapshot: (): ResourceSnapshot => ({ borrowedLeases: state.borrowed, cleanupBalance: state.cleanupBalance, openCursors: 0, openPrepared: 0 }), sideEffects: () => state.sideEffects, physicalSessionIds: () => [state.identity] }, reset: async () => { state.committedRows = 0; state.sideEffects = 0; state.bulkCalls = 0; state.bulkExec = 0; state.streamReturns = 0; state.preparedCalls = 0; state.pending.length = 0; state.savepoints.clear(); }, ...(guarded === undefined ? {} : { guarded }), unsupported: { TX028: { feature: "combination:serializable+readOnly", expectedErrorFeature: "transaction.isolation.serializable", expectedCode: "BRAID_TX_OPTION_UNSUPPORTED", run: async () => { throw new UnsupportedFeatureError("transaction.isolation.serializable", "BRAID_TX_OPTION_UNSUPPORTED", "synthetic option combination unsupported"); }, sideEffects: () => state.sideEffects }, ...(cancelUnsupported ? { STR006: { feature: "statement.cancel", expectedCode: "BRAID_CANCEL_UNSUPPORTED", run: async () => { throw new UnsupportedFeatureError("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "synthetic cancellation unsupported"); }, sideEffects: () => state.sideEffects } } : {}), ...(options.resultSetsUnsupported ? { CALL004: { feature: "routine.result-sets", expectedCode: "BRAID_RESULT_SETS_UNSUPPORTED", run: async () => { throw new UnsupportedFeatureError("routine.result-sets", "BRAID_RESULT_SETS_UNSUPPORTED", "synthetic multiple result sets unsupported"); }, sideEffects: () => state.sideEffects } } : {}) }, close: async () => { if (state.borrowed !== 0) throw new Error("synthetic pooled lease leaked"); } };
      return fixture;
    },
  };
}
