import { isPublicUnsupportedFeatureError, type Database, type EnvironmentCapability } from "@sqlbraid/core";
import { REQUIRED_API_CAPABILITY_IDS, type CapabilityStatus, type CertificationCaseId, type CertificationCaseResult, type CertificationFixture, type CertificationTarget, type ExpectedCapability, type ResourceSnapshot, type TransactionOptionKey } from "./types.js";
import { assert } from "./assert.js";
import { runBulkConformanceCase } from "../bulk-conformance.js";
import { runStreamingConformanceCase } from "../streaming-conformance.js";

interface CaseContext {
  readonly target: CertificationTarget;
  readonly fixture: CertificationFixture;
  readonly stress: boolean;
}

type CaseOperation = (context: CaseContext) => Promise<void>;

function textError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function capability(target: CertificationTarget, feature: string): ExpectedCapability {
  const value = target.expectedCapabilities[feature];
  if (value === undefined) throw new Error(`Missing expected capability declaration for ${feature}.`);
  return value;
}

function emptyResultError(context: CaseContext): { readonly feature: string; readonly code: `BRAID_${string}` } | undefined {
  const configured = context.fixture.queries.expected?.emptyResultError;
  const rows = context.target.expectedCapabilities["result.rows"];
  const conditional = rows?.status === "guarded" && rows.conditionCode !== undefined;
  const independent = context.target.expectedGuardedCases?.emptyResultError;
  if (configured !== undefined) {
    assert.ok(conditional, "empty-result error metadata requires a guarded result.rows condition.");
    assert.deepEqual(configured, independent, "empty-result error metadata must match the independent target contract.");
    return configured;
  }
  assert.equal(independent, undefined, "independent empty-result error metadata requires fixture evidence.");
  return undefined;
}

async function assertEmptyResult(context: CaseContext, operation: () => unknown | Promise<unknown>): Promise<void> {
  const expected = emptyResultError(context);
  if (expected === undefined) {
    await operation();
    return;
  }
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(isPublicUnsupportedFeatureError(error), `Expected a registered empty-result UnsupportedFeatureError, got ${textError(error)}`);
    assert.equal(error.feature, expected.feature);
    assert.equal(error.code, expected.code);
    return true;
  });
}

async function unsupported(context: CaseContext, id: CertificationCaseId, feature: string): Promise<CertificationCaseResult> {
  const expected = capability(context.target, feature);
  if (expected.status !== "unsupported") throw new Error(`${id} cannot use an unsupported proof while ${feature} is ${expected.status}.`);
  const probe = context.fixture.unsupported?.[id];
  if (probe === undefined) throw new Error(`${id} requires an explicit unsupported probe for ${feature}.`);
  const before = probe.sideEffects();
  let error: unknown;
  try {
    await probe.run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(isPublicUnsupportedFeatureError(error), `${id} must reject with a registered public UnsupportedFeatureError, got ${textError(error)}`);
  const expectedErrorFeature = probe.expectedErrorFeature ?? probe.feature;
  assert.equal(error.feature, expectedErrorFeature);
  assert.equal(error.code, probe.expectedCode);
  if (probe.expectedErrorFeature === undefined) assert.equal(error.code, expected.unsupportedCode ?? probe.expectedCode);
  assert.equal(probe.sideEffects(), before, `${id} performed a side effect before rejecting ${feature}`);
  return { status: "pass-unsupported", name: id, feature, rejectionFeature: expectedErrorFeature === feature ? undefined : expectedErrorFeature, code: error.code };
}

async function supported(context: CaseContext, id: CertificationCaseId, feature: string, operation: CaseOperation): Promise<CertificationCaseResult> {
  const expected = capability(context.target, feature);
  if (expected.status === "unsupported") return unsupported(context, id, feature);
  if (expected.status === "guarded" && !expected.conditionCode) throw new Error(`${feature} is guarded without a conditionCode.`);
  await operation(context);
  return { status: "pass", name: id, feature };
}

async function supportedAll(context: CaseContext, id: CertificationCaseId, features: readonly string[], operation: CaseOperation): Promise<CertificationCaseResult> {
  for (const feature of features) {
    const expected = capability(context.target, feature);
    if (expected.status === "unsupported") return unsupported(context, id, feature);
    if (expected.status === "guarded" && !expected.conditionCode) throw new Error(`${feature} is guarded without a conditionCode.`);
  }
  await operation(context);
  return { status: "pass", name: id, feature: features.join(",") };
}

async function cleanResources(fixture: CertificationFixture, before: ResourceSnapshot): Promise<void> {
  const after = await fixtureMetrics(fixture).snapshot();
  assert.equal(after.borrowedLeases, before.borrowedLeases);
  assert.equal(after.cleanupBalance, before.cleanupBalance);
  assert.equal(after.openCursors ?? 0, before.openCursors ?? 0);
  assert.equal(after.openPrepared ?? 0, before.openPrepared ?? 0);
}

function expectedValue(fixture: CertificationFixture, key: CertificationCaseId): unknown {
  const expected = fixture.queries.expected?.special[key];
  if (!Object.hasOwn(fixture.queries.expected?.special ?? {}, key)) throw new Error(`${key} has no independent expected value.`);
  return expected;
}

function queryResultRows(value: unknown): readonly unknown[] {
  assert.equal(typeof value, "object");
  assert.ok(value !== null);
  assert.equal((value as { readonly kind?: unknown }).kind, "rows");
  return (value as { readonly rows?: readonly unknown[] }).rows ?? [];
}

function databases(fixture: CertificationFixture): readonly Database[] {
  return fixture.pooled ? [fixture.db, fixture.pooled] : [fixture.db];
}

function fixtureMetrics(fixture: CertificationFixture): NonNullable<CertificationFixture["metrics"]> {
  if (!fixture.metrics) throw new Error("Certification fixture resource metrics are required for this supported case.");
  return fixture.metrics;
}

function streamFixture(fixture: CertificationFixture): NonNullable<CertificationFixture["stream"]> {
  if (!fixture.stream) throw new Error("Certification fixture stream evidence is required for this supported case.");
  return fixture.stream;
}

function assertCardinality(error: unknown, expected: "one" | "maybeOne", actual: number): void {
  assert.ok((error as { readonly name?: unknown })?.name === "DatabaseCardinalityError", `Expected DatabaseCardinalityError, got ${textError(error)}`);
  assert.equal((error as { readonly expected?: unknown }).expected, expected);
  assert.equal((error as { readonly actual?: unknown }).actual, actual);
}

function fidelityQueries(fixture: CertificationFixture): NonNullable<CertificationFixture["queries"]["fidelity"]> {
  if (!fixture.queries.fidelity) throw new Error("Certification fidelity queries are required.");
  return fixture.queries.fidelity;
}

function preparedQuery(
  fixture: CertificationFixture,
  name: string,
  query: import("@sqlbraid/core").PreparableQuery,
  prepareOptions?: import("@sqlbraid/core").PreparedFactoryOptions,
): unknown {
  const prepare = fixture.db.prepare as unknown as (
    name: string,
    factory: () => import("@sqlbraid/core").PreparableQuery,
    options?: import("@sqlbraid/core").PreparedFactoryOptions,
  ) => unknown;
  return prepare(name, () => query, prepareOptions);
}

async function runTransactionOption(context: CaseContext, id: CertificationCaseId, key: TransactionOptionKey, options: import("@sqlbraid/core").TransactionOptions): Promise<CertificationCaseResult> {
  const status = context.target.expectedTransactionOptions[key];
  if (status === undefined) throw new Error(`Missing independent transaction option declaration for ${key}.`);
  if (status === "unsupported") {
    const probe = context.fixture.unsupported?.[id];
    if (!probe) throw new Error(`${id} requires an explicit unsupported option probe.`);
    const before = probe.sideEffects();
    let error: unknown;
    try { await probe.run(); } catch (caught) { error = caught; }
    assert.ok(isPublicUnsupportedFeatureError(error));
    assert.equal(error.feature, probe.expectedErrorFeature ?? probe.feature);
    assert.equal(error.code, probe.expectedCode);
    assert.equal(probe.sideEffects(), before);
    return { status: "pass-unsupported", name: id, feature: key, rejectionFeature: (probe.expectedErrorFeature ?? probe.feature) === key ? undefined : (probe.expectedErrorFeature ?? probe.feature), code: error.code };
  }
  for (const db of databases(context.fixture)) {
    await db.tx(options, async (tx) => {
      await tx.one(context.fixture.queries.identity);
      if (options.readOnly === true) {
        const transaction = context.fixture.queries.transaction;
        if (!transaction) throw new Error(`${id} requires transaction fixture evidence.`);
        await assert.rejects(() => tx.execute(transaction.insert));
      }
    });
  }
  return { status: "pass", name: id, feature: key };
}

function assertStableStress(before: ResourceSnapshot, after: ResourceSnapshot): void {
  assert.equal(after.borrowedLeases, 0);
  assert.equal(after.cleanupBalance, before.cleanupBalance);
  assert.equal(after.openCursors ?? 0, before.openCursors ?? 0);
  assert.equal(after.openPrepared ?? 0, before.openPrepared ?? 0);
}

const RESULT_CASES = ["RES001", "RES002", "RES003", "RES004", "RES005", "RES006", "RES007", "RES008", "RES009", "RES010", "RES011"] as const;
const RESULT_LABELS: Readonly<Partial<Record<(typeof RESULT_CASES)[number], string>>> = {
  RES001: "__proto__",
  RES002: "constructor",
  RES003: "prototype",
  RES004: "toString",
  RES005: "hasOwnProperty",
};

async function runResultCase(fixture: CertificationFixture, id: (typeof RESULT_CASES)[number]): Promise<void> {
  const query = fixture.queries.special[id];
  if (!query) throw new Error(`${id} fixture query missing.`);
  const expectedError = fixture.queries.expected?.specialErrors?.[id];
  if (expectedError) {
    for (const db of databases(fixture)) {
      await assert.rejects(() => db.one(query), (error: unknown) => {
        const candidate = error as { readonly code?: unknown; readonly feature?: unknown; readonly message?: unknown };
        assert.ok(candidate.code === expectedError.code || String(candidate.message ?? "").includes(expectedError.code), `${id} error must expose ${expectedError.code}.`);
        if (expectedError.feature !== undefined) assert.equal(candidate.feature, expectedError.feature);
        return true;
      });
    }
    return;
  }
  const expected = expectedValue(fixture, id);
  for (const db of databases(fixture)) {
    const row: unknown = await db.one(query);
    assert.deepEqual(row, expected);
    const label = RESULT_LABELS[id];
    if (label) {
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.ok(Object.hasOwn(row as object, label), `${id} must preserve own ${label} property.`);
      assert.deepEqual((row as Record<string, unknown>)[label], (expected as Record<string, unknown>)[label]);
    }
  }
}

async function callRoutine(fixture: CertificationFixture, query: import("@sqlbraid/core").CallQuery): Promise<unknown> {
  if (fixture.queries.routines?.executionScope === "transaction") {
    return fixture.db.tx((tx) => tx.call(query));
  }
  return fixture.db.call(query);
}

const operations: Readonly<Record<CertificationCaseId, (context: CaseContext) => Promise<CertificationCaseResult>>> = {
  QRY001: async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const result = await db.execute(fixture.queries.one);
      assert.deepEqual(queryResultRows(result), [fixture.queries.expected?.one]);
    }
    return { status: "pass", name: "QRY001" };
  },
  QRY002: async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const result = await db.execute(fixture.queries.command);
      assert.equal(result.kind, "command");
      if (fixture.queries.expected?.commandAffectedRows !== undefined) assert.equal(result.command.affectedRows, fixture.queries.expected.commandAffectedRows);
    }
    return { status: "pass", name: "QRY002" };
  },
  QRY010: async (context) => { for (const db of databases(context.fixture)) { const expected = emptyResultError(context); if (expected === undefined) assert.deepEqual(await db.all(context.fixture.queries.zero), []); else await assertEmptyResult(context, () => db.all(context.fixture.queries.zero)); } return { status: "pass", name: "QRY010" }; },
  QRY011: async ({ fixture }) => { for (const db of databases(fixture)) assert.deepEqual(await db.all(fixture.queries.one), [fixture.queries.expected?.one]); return { status: "pass", name: "QRY011" }; },
  QRY012: async ({ fixture }) => { for (const db of databases(fixture)) assert.deepEqual(await db.all(fixture.queries.many), fixture.queries.expected?.many); return { status: "pass", name: "QRY012" }; },
  QRY020: async ({ fixture }) => { for (const db of databases(fixture)) assert.deepEqual(await db.one(fixture.queries.one), fixture.queries.expected?.one); return { status: "pass", name: "QRY020" }; },
  QRY021: async (context) => { for (const db of databases(context.fixture)) { const expected = emptyResultError(context); if (expected === undefined) await assert.rejects(() => db.one(context.fixture.queries.zero), (error: unknown) => { assertCardinality(error, "one", 0); return true; }); else await assertEmptyResult(context, () => db.one(context.fixture.queries.zero)); } return { status: "pass", name: "QRY021" }; },
  QRY022: async ({ fixture }) => { for (const db of databases(fixture)) await assert.rejects(() => db.one(fixture.queries.many), (error: unknown) => { assertCardinality(error, "one", 2); return true; }); return { status: "pass", name: "QRY022" }; },
  QRY030: async (context) => { for (const db of databases(context.fixture)) { const expected = emptyResultError(context); if (expected === undefined) assert.equal(await db.maybeOne(context.fixture.queries.zero), undefined); else await assertEmptyResult(context, () => db.maybeOne(context.fixture.queries.zero)); } return { status: "pass", name: "QRY030" }; },
  QRY031: async ({ fixture }) => { for (const db of databases(fixture)) assert.deepEqual(await db.maybeOne(fixture.queries.one), fixture.queries.expected?.one); return { status: "pass", name: "QRY031" }; },
  QRY032: async ({ fixture }) => { for (const db of databases(fixture)) await assert.rejects(() => db.maybeOne(fixture.queries.many), (error: unknown) => { assertCardinality(error, "maybeOne", 2); return true; }); return { status: "pass", name: "QRY032" }; },

  ...Object.fromEntries(RESULT_CASES.map((id) => [id, async ({ fixture }: CaseContext) => { await runResultCase(fixture, id); return { status: "pass", name: id }; }])) as Record<(typeof RESULT_CASES)[number], (context: CaseContext) => Promise<CertificationCaseResult>>,

  VAL001: async (context) => supported(context, "VAL001", "sql.native-transparency", async ({ fixture }) => {
    const values = fidelityQueries(fixture);
    const row = await fixture.db.one(values.largeExactInteger);
    assert.deepEqual(row, values.expected.largeExactInteger);
  }),
  VAL002: async (context) => supported(context, "VAL002", "sql.native-transparency", async ({ fixture }) => {
    const values = fidelityQueries(fixture);
    const row = await fixture.db.one(values.exactDecimal);
    assert.deepEqual(row, values.expected.exactDecimal);
  }),
  VAL003: async (context) => supported(context, "VAL003", "sql.native-transparency", async ({ fixture }) => {
    const values = fidelityQueries(fixture);
    const row = await fixture.db.one(values.temporal);
    assert.deepEqual(row, values.expected.temporal);
  }),
  VAL004: async (context) => supported(context, "VAL004", "sql.native-transparency", async ({ fixture }) => {
    const values = fidelityQueries(fixture);
    const metrics = fixtureMetrics(fixture);
    const expectedInjection = (values.expected.injection as { readonly value?: unknown }).value;
    assert.ok(values.injection.render().parameters.some((parameter) => parameter.value === expectedInjection), "VAL004 requires the injection payload to be a rendered bind.");
    if (metrics.mutationSentinel === undefined) throw new Error("VAL004 requires a native table-state sentinel.");
    const before = await metrics.mutationSentinel();
    const row = await fixture.db.one(values.injection);
    assert.deepEqual(row, values.expected.injection);
    assert.deepEqual(await metrics.mutationSentinel(), before);
  }),

  SES001: async (context) => supported(context, "SES001", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const ids: string[] = [];
      await db.session(async (session) => {
        ids.push((await session.one(fixture.queries.identity)).id);
        ids.push((await session.one(fixture.queries.identity)).id);
        if (emptyResultError(context) === undefined) assert.deepEqual(await session.all(fixture.queries.zero), []);
        else await assertEmptyResult(context, () => session.all(fixture.queries.zero));
        assert.deepEqual(await session.all(fixture.queries.many), fixture.queries.expected?.many);
        if (emptyResultError(context) === undefined) assert.deepEqual(await session.maybeOne(fixture.queries.zero), undefined);
        else await assertEmptyResult(context, () => session.maybeOne(fixture.queries.zero));
        assert.deepEqual(await session.maybeOne(fixture.queries.one), fixture.queries.expected?.one);
        await assert.rejects(
          () => session.maybeOne(fixture.queries.many),
          (error: unknown) => {
            assertCardinality(error, "maybeOne", fixture.queries.expected?.many.length ?? 2);
            return true;
          },
        );
      });
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
    }
    const metrics = fixtureMetrics(fixture);
    if (metrics.physicalSessionIds) assert.equal(new Set(metrics.physicalSessionIds()).size, 1);
    if (fixture.pooled !== undefined) {
      if (metrics.pooledScope === undefined) throw new Error("SES001 requires pooled native lease evidence.");
      await metrics.pooledScope();
    }
  }),
  SES002: async (context) => supported(context, "SES002", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const before = await fixtureMetrics(fixture).snapshot();
      await db.session(async (session) => { await session.one(fixture.queries.identity); });
      await cleanResources(fixture, before);
    }
    if (fixture.pooled !== undefined) {
      const scope = fixtureMetrics(fixture).pooledScope;
      if (scope === undefined) throw new Error("SES002 requires pooled native lease evidence.");
      await scope();
    }
  }),
  SES003: async (context) => supported(context, "SES003", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const before = await fixtureMetrics(fixture).snapshot();
      await assert.rejects(() => db.session(async () => { throw new Error("cert-session-callback"); }));
      await cleanResources(fixture, before);
    }
  }),
  SES004: async (context) => supported(context, "SES004", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      let scoped: Database | undefined;
      await db.session(async (session) => { scoped = session; });
      await assert.rejects(() => scoped!.one(fixture.queries.identity), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_SESSION_CLOSED");
    }
  }),
  SES005: async (context) => supported(context, "SES005", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      await assert.rejects(() => db.session(async () => { await db.one(fixture.queries.identity); }), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_SESSION_SCOPE");
    }
  }),
  SES006: async (context) => supported(context, "SES006", "session.pinned", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      const before = await fixtureMetrics(fixture).snapshot();
      await assert.rejects(() => db.session(async (session) => { await session.one(fixture.queries.failure); }));
      await cleanResources(fixture, before);
    }
  }),
  SES007: async (context) => supportedAll(context, "SES007", ["session.pinned", "statement.stream"], async ({ fixture }) => {
    const query = fixture.queries.stream ?? fixture.queries.many;
    const expected = fixture.stream?.expected ?? fixture.queries.expected?.many;
    if (expected === undefined) throw new Error("SES007 requires expected stream rows.");
    const metrics = fixtureMetrics(fixture);
    for (const db of databases(fixture)) {
      const before = await metrics.snapshot();
      await db.session(async (session) => {
        const rows: unknown[] = [];
        for await (const row of session.stream(query)) rows.push(row);
        assert.deepEqual(rows, expected);
        const inside = await metrics.snapshot();
        if (fixture.pooled !== undefined && db === fixture.pooled) assert.ok(inside.borrowedLeases > before.borrowedLeases);
      });
      await cleanResources(fixture, before);
    }
  }),
  SES008: async (context) => supportedAll(context, "SES008", ["session.pinned", "transaction"], async ({ fixture }) => {
    for (const db of databases(fixture)) {
      await db.session(async (session) => {
        const outer = await session.one(fixture.queries.identity);
        let nestedHandle: Database | undefined;
        let nestedTransaction: Database | undefined;
        await session.session(async (nestedSession) => {
          nestedHandle = nestedSession;
          const nested = await nestedSession.one(fixture.queries.identity);
          assert.equal(nested.id, outer.id);
          await nestedSession.tx(async (tx) => {
            nestedTransaction = tx;
            const transaction = await tx.one(fixture.queries.identity);
            assert.equal(transaction.id, outer.id);
          });
          await assert.rejects(() => nestedTransaction!.one(fixture.queries.identity), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_TX_CLOSED");
        });
        await assert.rejects(() => nestedHandle!.one(fixture.queries.identity), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_SESSION_CLOSED");
      });
    }
  }),

  TX001: async (context) => supported(context, "TX001", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX001 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await db.tx(async (tx) => { await tx.execute(fixture.queries.transaction!.insert); });
      assert.equal((await db.all(fixture.queries.transaction.visible)).length, 1);
    }
  }),
  TX002: async (context) => supported(context, "TX002", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX002 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await assert.rejects(() => db.tx(async (tx) => { await tx.execute(fixture.queries.transaction!.insert); throw new Error("cert-rollback"); }));
      if (emptyResultError(context) === undefined) assert.equal((await db.all(fixture.queries.transaction!.visible)).length, 0);
      else await assertEmptyResult(context, () => db.all(fixture.queries.transaction!.visible));
    }
  }),
  TX003: async (context) => supported(context, "TX003", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX003 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await assert.rejects(() => db.tx(async (tx) => { await tx.execute(fixture.queries.transaction!.insert); await tx.execute(fixture.queries.failure); }));
      if (emptyResultError(context) === undefined) assert.equal((await db.all(fixture.queries.transaction!.visible)).length, 0);
      else await assertEmptyResult(context, () => db.all(fixture.queries.transaction!.visible));
    }
  }),
  TX004: async (context) => supported(context, "TX004", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX004 transaction fixture missing.");
    for (const db of databases(fixture)) {
      const ids: string[] = [];
      await db.tx(async (tx) => {
        ids.push((await tx.one(fixture.queries.identity)).id);
        ids.push((await tx.one(fixture.queries.identity)).id);
        assert.deepEqual(await tx.all(fixture.queries.many), fixture.queries.expected?.many);
        if (emptyResultError(context) === undefined) assert.deepEqual(await tx.maybeOne(fixture.queries.zero), undefined);
        else await assertEmptyResult(context, () => tx.maybeOne(fixture.queries.zero));
      });
      assert.equal(ids[0], ids[1]);
    }
  }),
  TX005: async (context) => supported(context, "TX005", "transaction", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      await assert.rejects(() => db.tx(async () => { await db.one(fixture.queries.identity); }), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_TX_SCOPE");
    }
  }),
  TX006: async (context) => supported(context, "TX006", "transaction", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      let scoped: Database | undefined;
      await db.tx(async (tx) => { scoped = tx; });
      await assert.rejects(() => scoped!.one(fixture.queries.identity), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_TX_CLOSED");
    }
  }),
  TX007: async (context) => supported(context, "TX007", "transaction", async ({ fixture }) => {
    const proof = fixtureMetrics(fixture).transactionCleanup;
    if (!proof) throw new Error("TX007 requires a native rollback/release fault proof.");
    await proof();
  }),
  TX008: async (context) => supported(context, "TX008", "transaction", async ({ fixture }) => {
    for (const db of databases(fixture)) {
      await db.tx(async (tx) => { await tx.one(fixture.queries.identity); });
      await db.one(fixture.queries.identity);
    }
  }),
  TX009: async (context) => supported(context, "TX009", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX009 transaction fixture missing.");
    const proof = fixtureMetrics(fixture).readOnlyWrite;
    if (!proof) throw new Error("TX009 requires a native read-only write proof.");
    await proof();
  }),
  TX010: async (context) => supported(context, "TX010", "transaction.savepoint", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX010 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await db.tx(async (outer) => {
        await outer.tx(async (inner) => { await inner.execute(fixture.queries.transaction!.savepointInsert); });
      });
      assert.equal((await db.all(fixture.queries.transaction.visible)).length, 1);
    }
  }),
  TX011: async (context) => supported(context, "TX011", "transaction.savepoint", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX011 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await db.tx(async (outer) => {
        await assert.rejects(() => outer.tx(async (inner) => { await inner.execute(fixture.queries.transaction!.savepointInsert); throw new Error("cert-savepoint-rollback"); }));
      });
      if (emptyResultError(context) === undefined) assert.equal((await db.all(fixture.queries.transaction!.visible)).length, 0);
      else await assertEmptyResult(context, () => db.all(fixture.queries.transaction!.visible));
    }
  }),
  TX012: async (context) => supported(context, "TX012", "transaction", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX012 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await assert.rejects(() => db.tx(async (outer) => {
        await outer.tx(async (inner) => { await inner.execute(fixture.queries.transaction!.savepointInsert); });
        throw new Error("cert-outer-rollback");
      }));
      if (emptyResultError(context) === undefined) assert.equal((await db.all(fixture.queries.transaction!.visible)).length, 0);
      else await assertEmptyResult(context, () => db.all(fixture.queries.transaction!.visible));
    }
  }),
  TX013: async (context) => supported(context, "TX013", "transaction.savepoint", async ({ fixture }) => {
    if (!fixture.queries.transaction) throw new Error("TX013 transaction fixture missing.");
    for (const db of databases(fixture)) {
      await fixture.reset();
      await db.tx(async (outer) => {
        await outer.tx(async (inner) => {
          await inner.tx(async (deep) => { await deep.execute(fixture.queries.transaction!.savepointInsert); });
        });
      });
      assert.equal((await db.all(fixture.queries.transaction.visible)).length, 1);
    }
  }),
  TX020: async (context) => runTransactionOption(context, "TX020", "isolation:read-uncommitted", { isolation: "read-uncommitted" }),
  TX021: async (context) => runTransactionOption(context, "TX021", "readOnly:true", { readOnly: true }),
  TX022: async (context) => runTransactionOption(context, "TX022", "combination:read-committed+readOnly", { isolation: "read-committed", readOnly: true }),
  TX023: async (context) => runTransactionOption(context, "TX023", "isolation:read-committed", { isolation: "read-committed" }),
  TX024: async (context) => runTransactionOption(context, "TX024", "isolation:repeatable-read", { isolation: "repeatable-read" }),
  TX025: async (context) => runTransactionOption(context, "TX025", "isolation:serializable", { isolation: "serializable" }),
  TX026: async (context) => runTransactionOption(context, "TX026", "readOnly:false", { readOnly: false }),
  TX027: async (context) => runTransactionOption(context, "TX027", "combination:read-uncommitted+readOnly", { isolation: "read-uncommitted", readOnly: true }),
  TX028: async (context) => runTransactionOption(context, "TX028", "combination:serializable+readOnly", { isolation: "serializable", readOnly: true }),
  TX029: async (context) => runTransactionOption(context, "TX029", "combination:read-uncommitted+readWrite", { isolation: "read-uncommitted", readOnly: false }),
  TX030: async (context) => runTransactionOption(context, "TX030", "combination:read-committed+readWrite", { isolation: "read-committed", readOnly: false }),
  TX031: async (context) => runTransactionOption(context, "TX031", "combination:repeatable-read+readOnly", { isolation: "repeatable-read", readOnly: true }),
  TX032: async (context) => runTransactionOption(context, "TX032", "combination:repeatable-read+readWrite", { isolation: "repeatable-read", readOnly: false }),
  TX033: async (context) => runTransactionOption(context, "TX033", "combination:serializable+readWrite", { isolation: "serializable", readOnly: false }),

  PRE001: async (context) => supported(context, "PRE001", "statement.prepare", async ({ fixture }) => {
    const prepared = fixture.queries.prepared; if (!prepared) throw new Error("PRE001 prepared fixture missing.");
    const before = prepared.factoryCalls();
    const handle = fixture.db.prepare("cert-prepared-command", (input: unknown) => prepared.command(input));
    const result = await (handle as unknown as { execute(input: unknown): Promise<{ readonly kind: string }> }).execute(prepared.input);
    assert.equal(result.kind, "command");
    assert.equal(prepared.factoryCalls(), before + 1);
  }),
  PRE002: async (context) => supported(context, "PRE002", "statement.prepare", async ({ fixture }) => {
    const prepared = fixture.queries.prepared; if (!prepared) throw new Error("PRE002 prepared fixture missing.");
    const before = prepared.factoryCalls();
    const handle = fixture.db.prepare("cert-prepared-rows", (input: unknown) => prepared.rows(input));
    const rows = await (handle as unknown as { all(input: unknown): Promise<readonly unknown[]> }).all(prepared.input);
    assert.deepEqual(rows, fixture.queries.expected?.many ?? [fixture.queries.expected?.one]);
    assert.equal(prepared.factoryCalls(), before + 1);
  }),
  PRE003: async (context) => supportedAll(context, "PRE003", ["statement.prepare", "statement.stream"], async ({ fixture }) => {
    const prepared = fixture.queries.prepared; if (!prepared) throw new Error("PRE003 prepared fixture missing.");
    const before = prepared.factoryCalls();
    const handle = fixture.db.prepare("cert-prepared-stream", (input: unknown) => prepared.rows(input));
    const stream = (handle as unknown as { stream(input: unknown): AsyncIterable<unknown> }).stream(prepared.input);
    assert.equal(prepared.factoryCalls(), before);
    const values: unknown[] = []; for await (const row of stream) values.push(row);
    assert.deepEqual(values, fixture.queries.expected?.many ?? [fixture.queries.expected?.one]);
    assert.equal(prepared.factoryCalls(), before + 1);
    if (prepared.resources) assert.equal(prepared.resources(), 0);
  }),
  PRE004: async (context) => supportedAll(context, "PRE004", ["statement.prepare", "statement.stream"], async ({ fixture }) => {
    const prepared = fixture.queries.prepared; if (!prepared) throw new Error("PRE004 prepared fixture missing.");
    const before = prepared.factoryCalls();
    const handle = fixture.db.prepare("cert-prepared-unused", (input: unknown) => prepared.rows(input));
    void (handle as unknown as { stream(input: unknown): AsyncIterable<unknown> }).stream(prepared.input);
    assert.equal(prepared.factoryCalls(), before);
    if (prepared.resources) assert.equal(prepared.resources(), 0);
  }),
  PRE005: async (context) => supportedAll(context, "PRE005", ["statement.prepare", "statement.stream"], async ({ fixture }) => {
    const prepared = fixture.queries.prepared; if (!prepared) throw new Error("PRE005 prepared fixture missing.");
    const before = prepared.factoryCalls();
    const handle = fixture.db.prepare("cert-prepared-break", (input: unknown) => prepared.rows(input));
    for await (const row of (handle as unknown as { stream(input: unknown): AsyncIterable<unknown> }).stream(prepared.input)) { void row; break; }
    assert.equal(prepared.factoryCalls(), before + 1);
    if (prepared.resources) assert.equal(prepared.resources(), 0);
  }),
  PRE006: async (context) => supported(context, "PRE006", "statement.prepare", async ({ fixture }) => {
    const handle = preparedQuery(fixture, "cert-prepared-one", fixture.queries.one);
    const row = await (handle as unknown as { one(): Promise<unknown> }).one();
    assert.deepEqual(row, fixture.queries.expected?.one);
  }),
  PRE007: async (context) => supported(context, "PRE007", "statement.prepare", async ({ fixture }) => {
    const zero = preparedQuery(fixture, "cert-prepared-maybe-zero", fixture.queries.zero);
    const maybeZero = () => (zero as unknown as { maybeOne(): Promise<unknown> }).maybeOne();
    if (emptyResultError(context) === undefined) assert.equal(await maybeZero(), undefined);
    else await assertEmptyResult(context, maybeZero);
    const many = preparedQuery(fixture, "cert-prepared-maybe-many", fixture.queries.many);
    await assert.rejects(() => (many as unknown as { maybeOne(): Promise<unknown> }).maybeOne(), (error: unknown) => {
      assertCardinality(error, "maybeOne", 2);
      return true;
    });
  }),
  PRE008: async (context) => supported(context, "PRE008", "routine.call", async ({ fixture }) => {
    const routine = fixture.queries.routines?.call;
    if (!routine) throw new Error("PRE008 routine fixture missing.");
    const handle = preparedQuery(fixture, "cert-prepared-call", routine);
    const result = await (handle as unknown as { call(): Promise<unknown> }).call();
    assert.deepEqual(result, fixture.queries.expected?.special.CALL001);
  }),
  PRE009: async (context) => supported(context, "PRE009", "statement.prepare", async ({ fixture }) => {
    const prepare = fixture.db.prepare as unknown as (name: string, factory: (input: string) => import("@sqlbraid/core").PreparableQuery) => unknown;
    const handle = prepare("cert-prepared-shape", (input: string) => input === "one" ? fixture.queries.one : fixture.queries.command);
    await (handle as { execute(input: string): Promise<unknown> }).execute("one");
    await assert.rejects(() => (handle as { execute(input: string): Promise<unknown> }).execute("two"), (error: unknown) => (error as { readonly code?: unknown }).code === "BRAID_PREPARED_SHAPE");
  }),
  PRE010: async (context) => supported(context, "PRE010", "statement.prepare", async ({ fixture }) => {
    preparedQuery(fixture, "cert-prepared-duplicate", fixture.queries.one);
    let error: unknown;
    try { preparedQuery(fixture, "cert-prepared-duplicate", fixture.queries.one); } catch (caught) { error = caught; }
    assert.equal((error as { readonly code?: unknown }).code, "BRAID_PREPARED_NAME");
  }),
  PRE011: async (context) => supportedAll(context, "PRE011", ["statement.prepare", "statement.stream", "statement.cancel"], async ({ fixture }) => {
    const controller = new AbortController();
    const abortError = new Error("cert-prepared-abort");
    const handle = preparedQuery(fixture, "cert-prepared-abort", fixture.queries.stream ?? fixture.queries.many, { input: "none" });
    await assert.rejects(async () => {
      for await (const row of (handle as unknown as { stream(options?: { signal?: AbortSignal }): AsyncIterable<unknown> }).stream({ signal: controller.signal })) {
        void row;
        controller.abort(abortError);
      }
    }, (error: unknown) => error === abortError || (error instanceof AggregateError && error.errors.includes(abortError)));
  }),

  STR001: async (context) => supported(context, "STR001", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR001", () => ({ ...stream, close: undefined })); }),
  STR002: async (context) => supported(context, "STR002", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR002", () => ({ ...stream, close: undefined })); }),
  STR003: async (context) => supported(context, "STR003", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR003", () => ({ ...stream, close: undefined })); }),
  STR004: async (context) => supported(context, "STR004", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR004", () => ({ ...stream, close: undefined })); }),
  STR005: async (context) => supported(context, "STR005", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR005", () => ({ ...stream, close: undefined })); }),
  STR006: async (context) => supported(context, "STR006", "statement.cancel", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR006", () => ({ ...stream, close: undefined })); }),
  STR007: async (context) => supported(context, "STR007", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR007", () => ({ ...stream, close: undefined })); }),
  STR008: async (context) => supported(context, "STR008", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR008", () => ({ ...stream, close: undefined })); }),
  STR009: async (context) => supported(context, "STR009", "statement.stream", async ({ fixture }) => { const stream = streamFixture(fixture); await runStreamingConformanceCase("STR009", () => ({ ...stream, close: undefined })); }),
  STR010: async (context) => supported(context, "STR010", "statement.cancel", async ({ fixture }) => {
    const stream = streamFixture(fixture);
    await runStreamingConformanceCase("STR006", () => ({ ...stream, close: undefined }), { abortError: new Error("cert-custom-abort") });
  }),
  STR011: async (context) => supported(context, "STR011", "statement.stream", async ({ fixture }) => {
    const stream = streamFixture(fixture);
    await runStreamingConformanceCase("STR011", () => ({ ...stream, close: undefined }));
  }),

  CALL001: async (context) => supported(context, "CALL001", "routine.call", async ({ fixture }) => { if (!fixture.queries.routines) throw new Error("CALL001 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.call); assert.deepEqual(result, fixture.queries.expected?.special.CALL001); }),
  CALL002: async (context) => supported(context, "CALL002", "routine.out", async ({ fixture }) => { if (!fixture.queries.routines?.out) throw new Error("CALL002 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.out); assert.deepEqual(result, fixture.queries.expected?.special.CALL002); }),
  CALL003: async (context) => supported(context, "CALL003", "routine.inout", async ({ fixture }) => { if (!fixture.queries.routines?.inout) throw new Error("CALL003 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.inout); assert.deepEqual(result, fixture.queries.expected?.special.CALL003); }),
  CALL004: async (context) => supported(context, "CALL004", "routine.result-sets", async ({ fixture }) => { if (!fixture.queries.routines?.resultSets) throw new Error("CALL004 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.resultSets); assert.deepEqual(result, fixture.queries.expected?.special.CALL004); }),
  CALL005: async (context) => supported(context, "CALL005", "routine.out-cursor", async ({ fixture }) => { if (!fixture.queries.routines?.cursor) throw new Error("CALL005 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.cursor); assert.deepEqual(result, fixture.queries.expected?.special.CALL005); }),
  CALL006: async (context) => supported(context, "CALL006", "routine.return-value", async ({ fixture }) => { if (!fixture.queries.routines?.returnValue) throw new Error("CALL006 routine fixture missing."); const result = await callRoutine(fixture, fixture.queries.routines.returnValue); assert.deepEqual(result, fixture.queries.expected?.special.CALL006); }),
  CALL007: async (context) => supported(context, "CALL007", "routine.call", async ({ fixture }) => {
    const proof = fixtureMetrics(fixture).routineCleanup;
    if (!proof || !fixture.queries.routines?.lob) throw new Error("CALL007 requires a native routine LOB cleanup proof.");
    await proof(fixture.queries.routines.lob);
  }),

  BULK001: async (context) => supported(context, "BULK001", "statement.bulk", async ({ fixture }) => { if (!fixture.bulk) throw new Error("BULK001 bulk fixture missing."); await runBulkConformanceCase("BULK001", { ...fixture.bulk, close: undefined }); }),
  BULK002: async (context) => supported(context, "BULK002", "statement.bulk", async ({ fixture }) => { if (!fixture.bulk) throw new Error("BULK002 bulk fixture missing."); await runBulkConformanceCase("BULK002", { ...fixture.bulk, close: undefined }); }),
  BULK003: async (context) => supported(context, "BULK003", "statement.bulk", async ({ fixture }) => { if (!fixture.bulk) throw new Error("BULK003 bulk fixture missing."); await runBulkConformanceCase("BULK003", { ...fixture.bulk, close: undefined }); }),
  BULK004: async (context) => supportedAll(context, "BULK004", ["statement.bulk", "transaction"], async ({ fixture }) => {
    const bulk = fixture.bulk;
    if (!bulk) throw new Error("BULK004 bulk fixture missing.");
    const result = await fixture.db.tx(async (tx) => tx.bulk(bulk.inputs, bulk.factory));
    assert.deepEqual(result, bulk.expected);
  }),
  BAT001: async ({ fixture }) => {
    const results = await fixture.db.batch([fixture.queries.command, fixture.queries.command]);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.kind, "command");
      assert.equal(result.command.affectedRows, fixture.queries.expected?.commandAffectedRows);
    }
    return { status: "pass", name: "BAT001" };
  },
  BAT002: async ({ fixture }) => {
    const transaction = fixture.queries.transaction;
    if (!transaction) throw new Error("BAT002 transaction fixture missing.");
    await fixture.reset();
    await assert.rejects(
      () => fixture.db.batch([transaction.insert, fixture.queries.failure as never, fixture.queries.command]),
      (error: unknown) => { assert.equal((error as { readonly code?: unknown }).code, fixture.queries.expected?.failureCode); return true; },
    );
    assert.equal((await fixture.db.all(transaction.visible)).length, 1);
    await fixture.db.one(fixture.queries.identity);
    return { status: "pass", name: "BAT002" };
  },
  BAT003: async ({ fixture }) => {
    assert.deepEqual(await fixture.db.batch([]), []);
    return { status: "pass", name: "BAT003" };
  },
  CAP001: async ({ target, fixture }) => {
    const environment = await fixture.db.environment();
    const expected = Object.fromEntries(Object.entries(target.expectedCapabilities).map(([key, value]) => {
      const { unsupportedCode: _unsupportedCode, ...declaration } = value;
      return [key, declaration];
    }));
    assert.deepEqual(environment.capabilities, expected);
    return { status: "pass", name: "CAP001" };
  },
  CAP002: async (context) => {
    const representationFeature = (feature: string): boolean => feature.startsWith("data.") || feature.startsWith("numeric.") || feature.startsWith("sql.");
    const probes = Object.values(context.fixture.unsupported ?? {});
    const apiUnsupported = Object.entries(context.target.expectedCapabilities).filter(([, value]) => value.status === "unsupported");
    const representedApiFeatures = new Set(probes.map((probe) => probe?.feature));
    if (context.target.expectedCapabilities["result.multiple-sets"]?.status === "unsupported"
      && context.target.expectedCapabilities["routine.result-sets"]?.status === "unsupported"
      && representedApiFeatures.has("routine.result-sets")) {
      representedApiFeatures.add("result.multiple-sets");
    }
    for (const [feature] of apiUnsupported) {
      if (representedApiFeatures.has(feature)) continue;
      const proof = context.fixture.representationUnsupported?.[feature];
      if (proof && representationFeature(feature) && !(REQUIRED_API_CAPABILITY_IDS as readonly string[]).includes(feature)) {
        await proof.prove();
        representedApiFeatures.add(feature);
        continue;
      }
      throw new Error(`CAP002 missing unsupported API probe for ${feature}.`);
    }
    for (const probe of probes) {
      if (!probe) continue;
      const feature = probe.feature;
      const value = context.target.expectedCapabilities[feature];
      if (value && value.status !== "unsupported") throw new Error(`CAP002 probe ${feature} contradicts expected capability.`);
      const before = probe.sideEffects(); let error: unknown;
      try { await probe.run(); } catch (caught) { error = caught; }
      assert.ok(isPublicUnsupportedFeatureError(error));
      assert.equal(error.feature, probe.expectedErrorFeature ?? feature);
      assert.equal(error.code, probe.expectedCode);
      if (probe.expectedErrorFeature === undefined && value?.unsupportedCode) assert.equal(error.code, value.unsupportedCode);
      assert.equal(probe.sideEffects(), before);
    }
    for (const [feature, proof] of Object.entries(context.fixture.guarded ?? {})) {
      if (!proof) throw new Error(`CAP002 guarded proof ${feature} is missing.`);
      if (context.target.expectedCapabilities[feature]?.status !== "guarded") throw new Error(`CAP002 guarded proof ${feature} is not declared guarded.`);
      await proof.prove();
    }
    for (const [feature, value] of Object.entries(context.target.expectedCapabilities)) {
      if (value.status !== "guarded") continue;
      if (!context.fixture.guarded?.[feature]) throw new Error(`CAP002 missing guarded behavior proof for ${feature}.`);
    }
    return { status: "pass", name: "CAP002" };
  },
  ERR001: async ({ fixture }) => {
    const probes = Object.entries(fixture.unsupported ?? {});
    if (probes.length === 0) throw new Error("ERR001 requires at least one unsupported public API probe.");
    for (const [, probe] of probes) {
      const before = probe.sideEffects();
      let error: unknown;
      try { await probe.run(); } catch (caught) { error = caught; }
      assert.ok(isPublicUnsupportedFeatureError(error), "ERR001 requires a registered public UnsupportedFeatureError pair.");
      assert.equal(error.code, probe.expectedCode);
      assert.equal(error.feature, probe.expectedErrorFeature ?? probe.feature);
      assert.equal(probe.sideEffects(), before);
    }
    return { status: "pass", name: "ERR001" };
  },

  STRESS001: async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const before = await metrics.snapshot(); const count = stress ? 1000 : 10; for (let index = 0; index < count; index += 1) await fixture.db.one(fixture.queries.one); assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); return { status: "pass", name: "STRESS001" }; },
  STRESS002: async (context) => supported(context, "STRESS002", "transaction", async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const before = await metrics.snapshot(); const count = stress ? 1000 : 10; for (let index = 0; index < count; index += 1) await fixture.db.tx(async (tx) => { await tx.one(fixture.queries.identity); }); assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); }),
  STRESS003: async (context) => supported(context, "STRESS003", "statement.prepare", async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const before = await metrics.snapshot(); const count = stress ? 500 : 10; const prepared = fixture.queries.prepared; if (!prepared) throw new Error("STRESS003 prepared fixture missing."); for (let index = 0; index < count; index += 1) { const handle = fixture.db.prepare(`cert-stress-${index}`, (input: unknown) => prepared.rows(input)); await (handle as unknown as { all(input: unknown): Promise<readonly unknown[]> }).all(prepared.input); } assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); }),
  STRESS004: async (context) => supported(context, "STRESS004", "statement.stream", async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const stream = streamFixture(fixture); const before = await metrics.snapshot(); const count = stress ? 500 : 10; for (let index = 0; index < count; index += 1) { for await (const row of fixture.db.stream(stream.query)) { void row; break; } } assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); }),
  STRESS005: async (context) => supported(context, "STRESS005", "transaction", async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const before = await metrics.snapshot(); const count = stress ? 1000 : 10; for (let index = 0; index < count; index += 1) await assert.rejects(() => fixture.db.tx(async () => { throw new Error("stress-rollback"); })); assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); }),
  STRESS006: async (context) => supported(context, "STRESS006", "session.pinned", async ({ fixture, stress }) => { const metrics = fixtureMetrics(fixture); const before = await metrics.snapshot(); const count = stress ? 1000 : 10; for (let index = 0; index < count; index += 1) await fixture.db.session(async (session) => { await session.one(fixture.queries.identity); }); assertStableStress(before, await metrics.snapshot()); await fixture.db.one(fixture.queries.one); }),
  STRESS007: async ({ fixture }) => {
    const metrics = fixtureMetrics(fixture);
    const before = await metrics.snapshot();
    await fixture.db.one(fixture.queries.one);
    const after = await metrics.snapshot();
    assert.equal(after.borrowedLeases, before.borrowedLeases);
    assert.equal(after.cleanupBalance, before.cleanupBalance);
    assert.equal(after.openCursors ?? 0, before.openCursors ?? 0);
    assert.equal(after.openPrepared ?? 0, before.openPrepared ?? 0);
    return { status: "pass", name: "STRESS007" };
  },
};

export async function executeCertificationCase(
  target: CertificationTarget,
  fixture: CertificationFixture,
  id: CertificationCaseId,
  options: { readonly stress?: boolean } = {},
): Promise<CertificationCaseResult> {
  const operation = operations[id];
  if (!operation) throw new Error(`No certification implementation for ${id}.`);
  await fixture.reset();
  try {
    return await operation({ target, fixture, stress: options.stress === true });
  } catch (error) {
    return { status: "fail", name: id, error: textError(error) };
  }
}

export function certificationCaseNames(): Readonly<Record<CertificationCaseId, string>> {
  return Object.fromEntries(Object.entries(operations).map(([id]) => [id, id])) as Record<CertificationCaseId, string>;
}

export function capabilityStatus(capabilities: Readonly<Record<string, EnvironmentCapability>>, feature: string): CapabilityStatus {
  return capabilities[feature]?.status ?? "unsupported";
}
