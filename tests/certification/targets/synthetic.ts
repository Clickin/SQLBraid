import { UnsupportedFeatureError, type CallQuery, type CommandQuery, type Database, type DatabaseEnvironment, type Query, type QueryResultKind, type RowQuery, type StreamOptions, type TransactionOptions } from "@sqlbraid/core";
import { DatabaseCardinalityError } from "@sqlbraid/runtime";
import type { BulkConformanceFixture } from "../../bulk-conformance.js";
import type { StreamingConformanceFixture } from "../../streaming-conformance.js";
import type { CertificationFixture, CertificationTarget, ExpectedCapabilityContract, ResourceSnapshot } from "../types.js";

type Marker = "zero" | "one" | "many" | "command" | "identity" | "failure" | "stream" | "stream-init" | "stream-first" | "stream-mid" | "stream-cleanup" | "large" | "special" | "insert" | "savepoint-insert" | "transaction-visible" | "call";
type MarkedQuery = Query<unknown, QueryResultKind> & { readonly marker: Marker; readonly value?: unknown; readonly rows?: readonly unknown[] };

function query(marker: Marker, resultKind: QueryResultKind, value?: unknown, rows?: readonly unknown[]): MarkedQuery {
  return {
    marker,
    value,
    rows,
    ir: {} as never,
    values: [],
    resultKind,
    render: () => ({ segments: [], parameters: [], resultKind, dialectId: "synthetic" }) as never,
  };
}

function rowQuery(marker: Marker, rows: readonly unknown[], value?: unknown): RowQuery<unknown> {
  return query(marker, "rows", value, rows) as unknown as RowQuery<unknown>;
}

function commandQuery(marker: Marker): CommandQuery {
  return query(marker, "command") as unknown as CommandQuery;
}

function callQuery(value: unknown): CallQuery {
  return query("call", "call", value) as unknown as CallQuery;
}

interface SyntheticState {
  committedRows: number;
  sideEffects: number;
  cleanupBalance: number;
  identity: string;
  bulkCalls: number;
  bulkExec: number;
  streamReturns: number;
  activeScope?: "session" | "transaction";
  preparedCalls: number;
}

class SyntheticDatabase implements Database {
  private readonly state: SyntheticState;
  private readonly transactionRows?: { value: number };
  private active = true;
  private readonly scope: "root" | "session" | "transaction";
  private readonly environmentValue: DatabaseEnvironment;

  public constructor(state: SyntheticState, scope: "root" | "session" | "transaction" = "root", transactionRows?: { value: number }, environmentValue: DatabaseEnvironment = syntheticEnvironment) {
    this.state = state;
    this.scope = scope;
    this.transactionRows = transactionRows;
    this.environmentValue = environmentValue;
  }

  private ensure(): void {
    if (!this.active) throw Object.assign(new Error("scope closed"), { code: this.scope === "session" ? "BRAID_SESSION_CLOSED" : "BRAID_TX_CLOSED" });
    if (this.scope === "root" && this.state.activeScope) throw Object.assign(new Error("root database re-entry"), { code: "BRAID_REENTRY" });
  }

  private rowsFor(marked: MarkedQuery): readonly unknown[] {
    if (marked.marker === "zero") return [];
    if (marked.marker === "many") return [{ value: 1 }, { value: 2 }];
    if (marked.marker === "one") return [{ value: "one" }];
    if (marked.marker === "identity") return [{ id: this.state.identity }];
    if (marked.marker === "failure") throw Object.assign(new Error("synthetic query failure"), { code: "SYNTHETIC_QUERY_FAILURE" });
    if (marked.marker === "special") return [marked.value];
    if (marked.marker === "insert" || marked.marker === "savepoint-insert") return [];
    if (marked.marker === "stream" || marked.marker === "large") return marked.rows ?? [{ value: 1 }, { value: 2 }];
    return marked.rows ?? [];
  }

  public async environment(): Promise<DatabaseEnvironment> {
    this.ensure();
    return this.environmentValue;
  }

  public async all<Row>(statement: RowQuery<Row>): Promise<readonly Row[]> {
    this.ensure();
    const rows = this.rowsFor(statement as unknown as MarkedQuery);
    if ((statement as unknown as MarkedQuery).marker === "insert" || (statement as unknown as MarkedQuery).marker === "savepoint-insert") {
      return [] as Row[];
    }
    if ((statement as unknown as MarkedQuery).marker === "transaction-visible") return ((this.transactionRows?.value ?? this.state.committedRows) ? [{ value: 1 }] : []) as Row[];
    return rows as readonly Row[];
  }

  public async one<Row>(statement: RowQuery<Row>): Promise<Row> {
    const rows = await this.all(statement);
    if (rows.length !== 1) throw new DatabaseCardinalityError("one", rows.length);
    return rows[0]!;
  }

  public async maybeOne<Row>(statement: RowQuery<Row>): Promise<Row | undefined> {
    const rows = await this.all(statement);
    if (rows.length > 1) throw new DatabaseCardinalityError("maybeOne", rows.length);
    return rows[0];
  }

  public async execute(statement: Query<unknown, "rows" | "command" | "unknown">): Promise<never> {
    this.ensure();
    const marked = statement as unknown as MarkedQuery;
    if (marked.marker === "failure") throw Object.assign(new Error("synthetic query failure"), { code: "SYNTHETIC_QUERY_FAILURE" });
    if (statement.resultKind === "rows") {
      return { kind: "rows", rows: this.rowsFor(marked), rowCount: this.rowsFor(marked).length } as never;
    }
    if (marked.marker === "insert" || marked.marker === "savepoint-insert") {
      if (this.transactionRows) this.transactionRows.value += 1;
      else this.state.committedRows += 1;
      this.state.sideEffects += 1;
      return { kind: "command", rows: [], rowCount: 1, command: { affectedRows: 1 } } as never;
    }
    return { kind: "command", rows: [], rowCount: 1, command: { affectedRows: 1 } } as never;
  }

  public async call<Result extends import("@sqlbraid/core").RoutineCallResult>(statement: CallQuery<Result>): Promise<Result> {
    this.ensure();
    return (statement as unknown as MarkedQuery).value as Result;
  }

  public async batch<const Queries extends readonly Query<unknown, "rows" | "command" | "unknown">[]>(statements: Queries): Promise<{ readonly [K in keyof Queries]: import("@sqlbraid/core").ExecutionResultOf<Queries[K]> }> {
    const results: unknown[] = [];
    for (const statement of statements) {
      if ((statement as unknown as MarkedQuery).marker === "failure") {
        throw Object.assign(new Error("batch item failed"), { code: "BRAID_BATCH_ABORTED" });
      }
      results.push(await this.execute(statement));
    }
    return results as { readonly [K in keyof Queries]: import("@sqlbraid/core").ExecutionResultOf<Queries[K]> };
  }

  public async bulk<Input>(inputs: readonly Input[], factory: (input: Input, index: number) => CommandQuery): Promise<import("@sqlbraid/core").BulkResult> {
    this.ensure();
    if (inputs.length > 0) {
      this.state.bulkCalls += 1;
      this.state.bulkExec += 1;
    }
    for (let index = 0; index < inputs.length; index += 1) await this.execute(factory(inputs[index]!, index));
    return { inputCount: inputs.length, affectedRows: inputs.length };
  }

  public prepare<Factory extends () => import("@sqlbraid/core").PreparableQuery>(name: string, factory: Factory, _options: { readonly input: "none" }): import("@sqlbraid/core").PreparedQuery<never, ReturnType<Factory>>;
  public prepare<Factory extends (input: never) => import("@sqlbraid/core").PreparableQuery>(name: string, factory: Factory, options?: { readonly input: "required" }): import("@sqlbraid/core").PreparedQuery<Parameters<Factory>[0], ReturnType<Factory>>;
  public prepare(name: string, factory: (input?: unknown) => import("@sqlbraid/core").PreparableQuery): import("@sqlbraid/core").PreparedQuery<unknown, import("@sqlbraid/core").PreparableQuery> {
    this.ensure();
    const database = this;
    const make = (input?: unknown) => factory(input);
    return {
      name,
      execute: async (input?: unknown) => this.execute(make(input) as Query<unknown, "rows" | "command" | "unknown">),
      all: async (input?: unknown) => this.all(make(input) as RowQuery<unknown>),
      one: async (input?: unknown) => this.one(make(input) as RowQuery<unknown>),
      maybeOne: async (input?: unknown) => this.maybeOne(make(input) as RowQuery<unknown>),
      stream: (input?: unknown) => ({
        async *[Symbol.asyncIterator]() {
          for await (const row of database.stream(make(input) as RowQuery<unknown>)) yield row;
        },
      }),
    } as unknown as import("@sqlbraid/core").PreparedQuery<unknown, import("@sqlbraid/core").PreparableQuery>;
  }

  public stream<Row>(statement: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row> {
    this.ensure();
    const marked = statement as unknown as MarkedQuery;
    const signal = options?.signal;
    const schema = options?.schema;
    const values = marked.marker === "large" ? marked.rows ?? [{ value: 1 }, { value: 2 }, { value: 3 }] : marked.rows ?? [{ value: 1 }, { value: 2 }];
    const state = this.state;
    return {
      async *[Symbol.asyncIterator]() {
        if (signal?.aborted) throw signal.reason;
        if (marked.marker === "stream-init") throw new Error("synthetic iterator init failure");
        try {
          for (let index = 0; index < values.length; index += 1) {
            if (signal?.aborted) throw signal.reason;
            if (marked.marker === "stream-first" && index === 0) throw new Error("synthetic first next failure");
            if (marked.marker === "stream-mid" && index === 1) throw new Error("synthetic mid-stream failure");
            const value = values[index]!;
            if (schema) await schema["~standard"].validate(value);
            yield value as Row;
          }
        } finally {
          state.cleanupBalance += 0;
          state.streamReturns += 1;
          if (marked.marker === "stream-cleanup") throw marked.value ?? new Error("synthetic cleanup failure");
        }
      },
    };
  }

  public async session<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    this.ensure();
    const previous = this.state.activeScope;
    this.state.activeScope = "session";
    const scoped = new SyntheticDatabase(this.state, "session", undefined, this.environmentValue);
    try { return await callback(scoped); } finally { scoped.active = false; this.state.activeScope = previous; }
  }

  public async tx<T>(optionsOrCallback: TransactionOptions | ((database: Database) => Promise<T>), maybeCallback?: (database: Database) => Promise<T>): Promise<T> {
    this.ensure();
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error("transaction callback missing");
    const previous = this.state.activeScope;
    this.state.activeScope = "transaction";
    const transactionRows = { value: 0 };
    const scoped = new SyntheticDatabase(this.state, "transaction", transactionRows, this.environmentValue);
    try {
      const value = await callback(scoped);
      if (this.transactionRows) this.transactionRows.value += transactionRows.value;
      else this.state.committedRows += transactionRows.value;
      return value;
    } finally {
      scoped.active = false;
      this.state.activeScope = previous;
    }
  }
}

const CAPABILITY_KEYS = [
  "session.pinned", "transaction", "transaction.savepoint", "transaction.read-only",
  "transaction.isolation.read-uncommitted", "transaction.isolation.read-committed",
  "transaction.isolation.repeatable-read", "transaction.isolation.serializable",
  "statement.prepare", "statement.stream", "statement.cancel", "statement.bulk",
  "routine.call", "routine.out", "routine.inout", "routine.result-sets", "routine.out-cursor", "routine.return-value",
] as const;

export function syntheticExpectedCapabilities(cancelUnsupported = false): ExpectedCapabilityContract {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, {
    status: cancelUnsupported && key === "statement.cancel" ? "unsupported" : "guaranteed",
    ...(cancelUnsupported && key === "statement.cancel" ? { unsupportedCode: "BRAID_CANCEL_UNSUPPORTED" } : {}),
  }])) as ExpectedCapabilityContract;
}

const syntheticEnvironment: DatabaseEnvironment = {
  database: { product: "synthetic", version: "1", edition: "memory" },
  driver: { id: "certification-synthetic", version: "1", profile: "deterministic" },
  runtime: { id: "node", version: process.versions.node },
  capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { status: "guaranteed" }])) as DatabaseEnvironment["capabilities"],
  supportMatch: { status: "compatible", targetId: "certification-synthetic" },
};

function makeQueries() {
  const specialValues: Record<string, unknown> = {
    RES001: { ["__proto__"]: "safe" },
    RES002: { constructor: "safe" },
    RES003: { prototype: "safe" },
    RES004: { toString: "safe" },
    RES005: { hasOwnProperty: "safe" },
    RES006: "hello",
    RES007: "",
    RES008: null,
    RES009: "안녕하세요",
    RES010: new Uint8Array([0, 255, 16]),
    RES011: { value: "second" },
  };
  const special = Object.fromEntries(Object.entries(specialValues).map(([key, value]) => [key, rowQuery("special", [value], value)]));
  return {
    zero: rowQuery("zero", []),
    one: rowQuery("one", [{ value: "one" }]),
    many: rowQuery("many", [{ value: 1 }, { value: 2 }]),
    command: commandQuery("command"),
    identity: rowQuery("identity", [{ id: "synthetic-session-1" }]),
    failure: rowQuery("failure", []),
    stream: rowQuery("stream", [{ value: 1 }, { value: 2 }]),
    special,
    transaction: {
      insert: commandQuery("insert"),
      visible: rowQuery("transaction-visible", []),
      savepointInsert: commandQuery("savepoint-insert"),
      savepointVisible: rowQuery("transaction-visible", []),
    },
    prepared: {
      command: () => commandQuery("command"),
      rows: () => rowQuery("many", [{ value: 1 }, { value: 2 }]),
      input: "input",
      factoryCalls: () => 0,
      resources: () => 0,
    },
    routines: {
      call: callQuery({ output: { answer: 42 } }),
      out: callQuery({ output: { answer: 42 } }),
      inout: callQuery({ output: { answer: 43 } }),
      resultSets: callQuery({ resultSets: [[{ value: 1 }], [{ value: 2 }]] }),
      cursor: callQuery({ resultSets: [[{ value: 1 }]] }),
      returnValue: callQuery({ returnValue: 7 }),
    },
    expected: {
      one: { value: "one" },
      many: [{ value: 1 }, { value: 2 }],
      special: {
        ...specialValues,
        CALL001: { output: { answer: 42 } },
        CALL002: { output: { answer: 42 } },
        CALL003: { output: { answer: 43 } },
        CALL004: { resultSets: [[{ value: 1 }], [{ value: 2 }]] },
        CALL005: { resultSets: [[{ value: 1 }]] },
        CALL006: { returnValue: 7 },
      },
      commandAffectedRows: 1,
      failureCode: "SYNTHETIC_QUERY_FAILURE",
    },
  };
}

export function createSyntheticTarget(sourceSha = "synthetic-source-sha", cancelUnsupported = true): CertificationTarget {
  const expectedCapabilities = syntheticExpectedCapabilities(cancelUnsupported);
  const expectedTransactionOptions = {
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
    "combination:serializable+readOnly": "unsupported",
    "combination:serializable+readWrite": "guaranteed",
  } as const;
  const environment = cancelUnsupported
    ? { ...syntheticEnvironment, capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { status: key === "statement.cancel" ? "unsupported" : "guaranteed" }])) as DatabaseEnvironment["capabilities"] }
    : syntheticEnvironment;
  return {
    id: cancelUnsupported ? "synthetic-unsupported" : "synthetic-memory",
    sourceSha,
    expectedCapabilities,
    expectedTransactionOptions,
    createFixture: async () => {
      const state: SyntheticState = { committedRows: 0, sideEffects: 0, cleanupBalance: 0, identity: "synthetic-session-1", bulkCalls: 0, bulkExec: 0, streamReturns: 0, preparedCalls: 0 };
      const db = new SyntheticDatabase(state, "root", undefined, environment);
      const queries = makeQueries();
      queries.prepared = {
        command: () => { state.preparedCalls += 1; return commandQuery("command"); },
        rows: () => { state.preparedCalls += 1; return rowQuery("many", [{ value: 1 }, { value: 2 }]); },
        input: "input",
        factoryCalls: () => state.preparedCalls,
        resources: () => 0,
      };
      const cleanupFailure = new Error("synthetic cleanup failure");
      const stream = {
        db,
        query: queries.stream,
        expected: [{ value: 1 }, { value: 2 }],
        mappingQuery: queries.stream,
        initFailureQuery: rowQuery("stream-init", []),
        firstNextFailureQuery: rowQuery("stream-first", [{ value: 1 }]),
        midStreamFailureQuery: rowQuery("stream-mid", [{ value: 1 }, { value: 2 }]),
        cleanupFailureQuery: rowQuery("stream-cleanup", [], cleanupFailure),
        largeResultQuery: rowQuery("large", [{ value: 1 }, { value: 2 }, { value: 3 }]),
        cleanupFailure,
        iteratorReturns: () => state.streamReturns,
        released: () => state.streamReturns,
      } as unknown as StreamingConformanceFixture<unknown>;
      const bulk: BulkConformanceFixture<unknown> = {
        db,
        inputs: [1, 2],
        factory: () => commandQuery("command"),
        expected: { inputCount: 2, affectedRows: 2 },
        acquireCount: () => state.bulkCalls,
        executeCount: () => state.bulkExec,
        values: () => [[1], [2]],
        middleFailure: async () => { throw new Error("synthetic middle failure"); },
      };
      const fixture: CertificationFixture = {
        db,
        queries: queries as CertificationFixture["queries"],
        stream,
        bulk,
        metrics: {
          snapshot: (): ResourceSnapshot => ({ borrowedLeases: 0, cleanupBalance: state.cleanupBalance, openCursors: 0, openPrepared: 0 }),
          sideEffects: () => state.sideEffects,
          physicalSessionIds: () => [state.identity],
        },
        reset: async () => { state.committedRows = 0; state.bulkCalls = 0; state.bulkExec = 0; state.streamReturns = 0; state.preparedCalls = 0; },
        unsupported: {
          TX028: {
            feature: "combination:serializable+readOnly",
            expectedCode: "BRAID_TX_OPTION_UNSUPPORTED",
            run: async () => { throw new UnsupportedFeatureError("combination:serializable+readOnly", "BRAID_TX_OPTION_UNSUPPORTED", "synthetic option combination unsupported"); },
            sideEffects: () => state.sideEffects,
          },
          ...(cancelUnsupported ? {
          STR006: {
            feature: "statement.cancel",
            expectedCode: "BRAID_CANCEL_UNSUPPORTED",
            run: async () => { throw new UnsupportedFeatureError("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "synthetic cancellation unsupported"); },
            sideEffects: () => state.sideEffects,
          },
          } : {}),
        },
      };
      return fixture;
    },
  };
}
