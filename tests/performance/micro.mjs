import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createStatementBindingDescription, parameterizedSql } from "@sqlbraid/core";
import { preparePositionalResultProjector, identityResultValue } from "@sqlbraid/core/driver";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { sql } from "@sqlbraid/template";
import { typePolicy, typePolicyForProfile } from "@sqlbraid/postgres";
import { createPgExecutor } from "@sqlbraid/postgres/pg";

const identity = (value) => value;
const placeholder = (index) => `$${index}`;
const bindingContext = { dialectId: "postgres", requestedReuse: "auto" };
const statementBinding = Object.freeze({
  id: "performance-fake",
  describe(statement, context) {
    return createStatementBindingDescription(statement, context, {
      adapterId: "performance-fake",
      transport: "text-positional",
      placeholder,
      reuse: { effective: "simple", owner: "sqlbraid" },
    });
  },
});
const environment = {
  database: { product: "performance-fake" },
  driver: { id: "performance-fake", version: "1", profile: "no-network" },
  capabilities: Object.fromEntries(
    ["session.pinned", "transaction", "statement.prepare"].map((key) => [key, { status: "guaranteed" }]),
  ),
};

// The baseline and runtime share this SPI implementation, result allocation, and counters.
function fake(rows, asynchronous = false) {
  const counts = { query: 0, acquire: 0, release: 0, begin: 0, commit: 0, rollback: 0 };
  const result = () => {
    counts.query += 1;
    return { kind: "rows", rows, rowCount: rows.length };
  };
  const executor = {
    statementBinding,
    environment,
    query: asynchronous ? async () => result() : () => result(),
    async *stream() {
      yield* rows;
    },
    call() {
      throw new Error("Routine calls are not supported by the performance fixture.");
    },
    begin() {
      counts.begin += 1;
    },
    commit() {
      counts.commit += 1;
    },
    rollback() {
      counts.rollback += 1;
    },
  };
  const provider = {
    statementBinding,
    environment,
    async acquire() {
      counts.acquire += 1;
      return {
        ...executor,
        release() {
          counts.release += 1;
        },
      };
    },
  };
  return { executor, provider, counts };
}

function lifecycleCases(add) {
  const rows = [{ id: "1", name: "Ada" }];
  const query = sql.rows`SELECT ${1} AS id, ${"Ada"} AS name`;
  const statement = query.render();
  for (const asynchronous of [false, true]) {
    const fixture = fake(rows, asynchronous);
    const direct = createDatabase(fixture.executor);
    const pooled = createPooledDatabase(fixture.provider);
    const prepared = pooled.prepare("micro-prepared", (id) => sql.rows`SELECT ${id} AS id, ${"Ada"} AS name`);
    const batch = Array.from({ length: 10 }, () => query);
    const queryMany = async (executor) => {
      const results = [];
      for (let index = 0; index < 10; index += 1) results.push(await executor.query(statement));
      return results;
    };
    const scopedBaseline = async (transaction) => {
      const lease = await fixture.provider.acquire();
      try {
        if (transaction) await lease.begin();
        const results = await queryMany(lease);
        if (transaction) await lease.commit();
        return results;
      } catch (error) {
        if (transaction) await lease.rollback();
        throw error;
      } finally {
        await lease.release();
      }
    };
    const scopedRuntime = (transaction) =>
      pooled[transaction ? "tx" : "session"](async (db) => {
        const results = [];
        for (let index = 0; index < 10; index += 1) results.push(await db.execute(query));
        return results;
      });
    const providerQuery = async () => {
      const lease = await fixture.provider.acquire();
      try {
        return await lease.query(statement);
      } finally {
        await lease.release();
      }
    };
    const pairs = [
      ["direct", () => fixture.executor.query(statement), () => direct.execute(query), 1, {}],
      ["provider", providerQuery, () => pooled.execute(query), 1, { acquire: 1, release: 1 }],
      ["prepared", providerQuery, () => prepared.execute(1), 1, { acquire: 1, release: 1 }],
      ["batch-10", () => scopedBaseline(false), () => pooled.batch(batch), 10, { acquire: 1, release: 1 }],
      ["session-10", () => scopedBaseline(false), () => scopedRuntime(false), 10, { acquire: 1, release: 1 }],
      [
        "transaction-10",
        () => scopedBaseline(true),
        () => scopedRuntime(true),
        10,
        { acquire: 1, release: 1, begin: 1, commit: 1 },
      ],
      [
        "acquire-release",
        async () => {
          const lease = await fixture.provider.acquire();
          await lease.release();
        },
        () => pooled.session(async () => undefined),
        0,
        { acquire: 1, release: 1 },
      ],
    ];
    for (const [name, baseline, runtime, operations, expected] of pairs) {
      const verify = async () => {
        const capture = async (run) => {
          const previous = { ...fixture.counts };
          const result = await run();
          const delta = Object.fromEntries(
            Object.entries(fixture.counts).map(([key, value]) => [key, value - previous[key]]),
          );
          assert.deepEqual(delta, {
            query: operations,
            acquire: 0,
            release: 0,
            begin: 0,
            commit: 0,
            rollback: 0,
            ...expected,
          });
          return result;
        };
        assert.deepEqual(await capture(runtime), await capture(baseline));
      };
      const group = `micro/lifecycle/${asynchronous ? "async" : "sync"}-executor/${name}`;
      const metadata = {
        logicalOperationsPerInvocation: operations,
        baseline: "Same SPI executor; pre-rendered statement, no runtime binding or result checks",
        lifecycleCountsPerInvocation: { query: operations, ...expected },
      };
      add({
        name: `${group}/baseline`,
        group,
        implementation: "fake-executor",
        category: "lifecycle",
        run: baseline,
        async: name !== "direct" || asynchronous,
        verify,
        metadata,
      });
      add({
        name: `${group}/runtime`,
        group,
        implementation: "sqlbraid",
        category: "lifecycle",
        run: runtime,
        async: true,
        verify,
        metadata,
      });
    }
  }
}

function templateCases(add) {
  for (const count of [1, 10, 50]) {
    const strings = Array.from({ length: count + 1 }, (_, index) =>
      index === 0 ? "SELECT " : index === count ? "" : ", ",
    );
    Object.defineProperty(strings, "raw", { value: Object.freeze([...strings]) });
    Object.freeze(strings);
    const values = Array.from({ length: count }, (_, index) => index + 1);
    const create = () => sql.rows(strings, ...values);
    const query = create();
    const rendered = query.render();
    const expectedSql = `SELECT ${values.map((_, index) => placeholder(index + 1)).join(", ")}`;
    const group = `micro/template/parameters-${count}`;
    const verify = () => {
      assert.deepEqual(
        create()
          .render()
          .parameters.map(({ value }) => value),
        values,
      );
      assert.equal(parameterizedSql(rendered, placeholder), expectedSql);
      assert.equal(statementBinding.describe(rendered, bindingContext).parameterizedSql, expectedSql);
    };
    for (const [stage, run] of [
      ["tag-creation", create],
      ["render-existing", () => query.render()],
      ["create-render", () => create().render()],
      ["placeholder-render", () => parameterizedSql(rendered, placeholder)],
      ["binding-description", () => statementBinding.describe(rendered, bindingContext)],
      ["binding-and-placeholders", () => statementBinding.describe(rendered, bindingContext).parameterizedSql],
    ])
      add({
        name: `${group}/${stage}`,
        group,
        implementation: "sqlbraid",
        category: "micro",
        run,
        async: false,
        verify,
        metadata: { parameters: count, stage },
      });
    const rows = [{ id: "1", name: "Ada" }];
    const fixture = fake(rows);
    const unobserved = createDatabase(fixture.executor);
    const observed = createDatabase(fixture.executor, { observers: [{ onEvent() {} }] });
    const observerGroup = `micro/observer/parameters-${count}`;
    const verifyObservers = async () => {
      const events = [];
      const counted = createDatabase(fixture.executor, {
        observers: [
          {
            onEvent(event) {
              events.push(event.type);
            },
          },
        ],
      });
      const expected = { kind: "rows", rows, rowCount: 1 };
      assert.deepEqual(await unobserved.execute(query), expected);
      assert.deepEqual(await observed.execute(query), expected);
      assert.deepEqual(await counted.execute(query), expected);
      assert.deepEqual(events, ["query:ready", "query:result", "query:mapped"]);
    };
    for (const [mode, db] of [
      ["none", unobserved],
      ["noop", observed],
    ]) {
      add({
        name: `${observerGroup}/${mode}`,
        group: observerGroup,
        implementation: "sqlbraid",
        category: "micro",
        run: () => db.execute(query),
        async: true,
        verify: verifyObservers,
        metadata: {
          parameters: count,
          stage: "static pre-created query through actual runtime and synchronous fake SPI",
          observers: mode === "none" ? 0 : 1,
          logicalOperationsPerInvocation: 1,
        },
      });
    }
  }
}

const columnTypes = ["int4", "text", "int8", "numeric", "timestamptz", "bool", "float8", "jsonb"];
function rowFixture(shape, count) {
  const width = shape === "narrow" ? 2 : shape === "wide" ? 32 : 8;
  const fields = Array.from({ length: width }, (_, index) => ({
    name: `c${index}`,
    dataType: columnTypes[index % columnTypes.length],
  }));
  const rows = Array.from({ length: count }, (_, index) => {
    const values = [
      index,
      `name-${index}`,
      "9007199254740993",
      "12345678901234567890.123456789",
      "2026-01-02 03:04:05.123456+00",
      true,
      1.25,
      '{"amount":9007199254740993}',
    ];
    return fields.map((field, column) =>
      shape === "nullable-mixed" && (index + column) % 3 === 0 ? null : values[column % values.length],
    );
  });
  // Independent oracle: do not use the decoder/projector under measurement to derive expected rows.
  const expected = rows.map((row) =>
    Object.fromEntries(
      fields.map((field, index) => [
        field.name,
        row[index] !== null && field.dataType === "int4" ? String(row[index]) : row[index],
      ]),
    ),
  );
  return { fields, rows, expected };
}

const fixtureSchema = (fn) => ({ "~standard": { version: 1, vendor: "performance-fixture", validate: fn } });
function schemas(fields) {
  const validate = (row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      return { issues: [{ message: "Expected row object" }] };
    for (const field of fields) {
      const value = row[field.name];
      const expectedType = field.dataType === "bool" ? "boolean" : field.dataType === "float8" ? "number" : "string";
      if (value !== null && typeof value !== expectedType) return { issues: [{ message: `Invalid ${field.name}` }] };
    }
    return { value: row };
  };
  const transform = (row) => {
    const result = validate(row);
    return result.issues ? result : { value: { ...row, label: row.c1 === null ? null : row.c1.toUpperCase() } };
  };
  return {
    "sync-validation": fixtureSchema(validate),
    "async-validation": fixtureSchema(async (row) => validate(row)),
    "sync-transform": fixtureSchema(transform),
    "async-transform": fixtureSchema(async (row) => transform(row)),
  };
}

function materializationCases(add, profile) {
  const cardinalities = profile === "smoke" ? [0, 1, 10] : [0, 1, 10, 100, 1000, 10000];
  const query = sql.rows`SELECT fixture`;
  const statement = query.render();
  for (const shape of ["narrow", "wide", "nullable-mixed"]) {
    for (const count of cardinalities) {
      const { rows, fields, expected } = rowFixture(shape, count);
      const nativeResult = { rows, fields, rowCount: count, command: "SELECT" };
      let lastRequest;
      const client = {
        async query(request) {
          lastRequest = request;
          return nativeResult;
        },
        escapeIdentifier: (value) => `"${value.replaceAll('"', '""')}"`,
        escapeLiteral: (value) => `'${value.replaceAll("'", "''")}'`,
      };
      const executor = createPgExecutor(client);
      const db = createDatabase(executor);
      const binding = executor.statementBinding.describe(statement, bindingContext);
      const nativeRequest = { text: parameterizedSql(statement, placeholder), values: [], rowMode: "array" };
      const columns = fields.map((field, index) => ({
        name: field.name,
        index,
        decode: (value) => typePolicy.decode(field.dataType, value),
      }));
      const identityColumns = fields.map((field, index) => ({ name: field.name, index, decode: identityResultValue }));
      const project = preparePositionalResultProjector(columns, count);
      const identityProject = preparePositionalResultProjector(identityColumns, count);
      const group = `micro/materialization/${shape}/${count}`;
      const metadata = {
        rows: count,
        columns: fields.length,
        representation: "pg lossless text; array-mode native rows",
        logicalOperationsPerInvocation: 1,
      };
      const addStage = (stage, implementation, run, asynchronous, verify) =>
        add({
          name: `${group}/${stage}`,
          group,
          implementation,
          category: "micro",
          run,
          async: asynchronous,
          verify,
          metadata: { ...metadata, stage },
        });
      addStage(
        "native-result",
        "fake-pg-client",
        () => client.query(nativeRequest),
        true,
        async () => assert.deepEqual((await client.query(nativeRequest)).rows, rows),
      );
      addStage(
        "projection-only",
        "sqlbraid-core-driver",
        () => rows.map(identityProject),
        false,
        () =>
          assert.deepEqual(
            rows.map(identityProject),
            rows.map((row) => Object.fromEntries(fields.map((field, index) => [field.name, row[index]]))),
          ),
      );
      addStage(
        "type-policy-only",
        "sqlbraid-postgres",
        () => rows.map((row) => row.map((value, index) => typePolicy.decode(fields[index].dataType, value))),
        false,
        () =>
          assert.deepEqual(
            rows.map((row) => row.map((value, index) => typePolicy.decode(fields[index].dataType, value))),
            expected.map((row) => fields.map((field) => row[field.name])),
          ),
      );
      addStage(
        "projector-prepared",
        "sqlbraid-core-driver",
        () => rows.map(project),
        false,
        () => assert.deepEqual(rows.map(project), expected),
      );
      addStage(
        "projector-setup-and-rows",
        "sqlbraid-core-driver",
        () => rows.map(preparePositionalResultProjector(columns, count)),
        false,
        () => assert.deepEqual(rows.map(preparePositionalResultProjector(columns, count)), expected),
      );
      const verifyExecutor = async () => {
        assert.deepEqual((await executor.query(statement, binding)).rows, expected);
        assert.equal(lastRequest.rowMode, "array");
        assert.equal(lastRequest.text, nativeRequest.text);
        assert.deepEqual(lastRequest.values, []);
      };
      addStage(
        "pg-executor-prebound",
        "sqlbraid-postgres",
        () => executor.query(statement, binding),
        true,
        verifyExecutor,
      );
      addStage(
        "pg-executor-bind-and-query",
        "sqlbraid-postgres",
        () => executor.query(statement),
        true,
        async () => assert.deepEqual((await executor.query(statement)).rows, expected),
      );
      addStage(
        "runtime-no-validation",
        "sqlbraid",
        () => db.all(query),
        true,
        async () => assert.deepEqual(await db.all(query), expected),
      );
      for (const [name, schema] of Object.entries(schemas(fields))) {
        const expectedOutput = name.endsWith("transform")
          ? expected.map((row) => ({ ...row, label: row.c1 === null ? null : row.c1.toUpperCase() }))
          : expected;
        const mapped = sql.rows(schema)`SELECT fixture`;
        addStage(
          `runtime-${name}`,
          "sqlbraid",
          () => db.all(mapped),
          true,
          async () => {
            assert.deepEqual(await db.all(mapped), expectedOutput);
            const invalid = await schema["~standard"].validate({ c0: false });
            assert.ok(invalid.issues?.length);
          },
        );
        const validate = schema["~standard"].validate;
        const run = name.startsWith("async")
          ? async () => {
              const output = [];
              for (const row of expected) output.push((await validate(row)).value);
              return output;
            }
          : () => expected.map((row) => validate(row).value);
        addStage(`schema-only-${name}`, "standard-schema-fixture", run, name.startsWith("async"), async () =>
          assert.deepEqual(await run(), expectedOutput),
        );
      }
    }
  }
  const temporal = "2026-01-02 03:04:05.123456+00";
  const date = new Date("2026-01-02T03:04:05.123Z");
  const native = typePolicyForProfile({ temporal: "native" });
  add({
    name: "micro/value-fidelity/decoders",
    group: "micro/value-fidelity",
    implementation: "sqlbraid-postgres",
    category: "micro",
    async: false,
    run: () => [
      typePolicy.decode("int8", 9007199254740993n),
      typePolicy.decode("numeric", "1.000000000000000001"),
      typePolicy.decode("timestamptz", temporal),
      native.decode("timestamptz", date),
    ],
    verify: () => {
      assert.equal(typePolicy.decode("int8", 9007199254740993n), "9007199254740993");
      assert.equal(typePolicy.decode("numeric", "1.000000000000000001"), "1.000000000000000001");
      assert.equal(typePolicy.decode("timestamptz", temporal), temporal);
      assert.equal(native.decode("timestamptz", date), date);
      assert.throws(() => typePolicy.decode("numeric", 1.1));
      assert.throws(() => typePolicy.decode("timestamptz", date));
      assert.throws(() => native.decode("timestamptz", temporal));
    },
    metadata: { stage: "exact numeric and explicit temporal profiles", logicalOperationsPerInvocation: 4 },
  });
}

const dynamicBodies = {
  static: "SELECT ${value(1)} AS id",
  "one-filter":
    "SELECT id FROM users /*@braid where*/ /*@braid if ${enabled}*/ AND id = ${value(1)} /*@braid end*/ /*@braid end*/",
  "five-filters":
    "SELECT id FROM users /*@braid where*/ /*@braid if ${enabled}*/ AND a = ${value(1)} /*@braid end*/ /*@braid if ${enabled}*/ AND b = ${value(2)} /*@braid end*/ /*@braid if ${enabled}*/ AND c = ${value(3)} /*@braid end*/ /*@braid if ${enabled}*/ AND d = ${value(4)} /*@braid end*/ /*@braid if ${enabled}*/ AND e = ${value(5)} /*@braid end*/ /*@braid end*/",
  "nested-if":
    "SELECT id FROM users /*@braid if ${enabled}*/ WHERE a = ${value(1)} /*@braid if ${enabled}*/ AND b = ${value(2)} /*@braid end*/ /*@braid end*/",
  choose:
    "SELECT id FROM users /*@braid choose*/ /*@braid when ${enabled}*/ WHERE a = ${value(1)} /*@braid when ${enabled}*/ WHERE b = ${value(2)} /*@braid otherwise*/ WHERE c = ${value(3)} /*@braid end*/",
  where:
    "SELECT id FROM users /*@braid where*/ /*@braid if ${enabled}*/ OR id = ${value(1)} /*@braid end*/ /*@braid end*/",
  set: "UPDATE users /*@braid set*/ a = ${value(1)}, /*@braid if ${enabled}*/ b = ${value(2)}, /*@braid end*/ /*@braid end*/ WHERE id = ${value(3)}",
  trim: 'SELECT id FROM users /*@braid trim prefix="WHERE " prefixOverrides="AND|OR"*/ /*@braid if ${enabled}*/ AND id = ${value(1)} /*@braid end*/ /*@braid end*/',
  identifiers:
    'SELECT ${sql.ident("id")} FROM ${sql.ident("users")} /*@braid if ${enabled}*/ WHERE ${sql.ident("id")} = ${value(1)} /*@braid end*/',
  fragments: "SELECT id FROM users /*@braid if ${enabled}*/ WHERE ${sql.fragment`id = ${value(1)}`} /*@braid end*/",
};
const lazyCalls = {
  static: [1, 1, 1],
  "one-filter": [1, 0, 1],
  "five-filters": [5, 0, 5],
  "nested-if": [2, 0, 2],
  choose: [3, 1, 1],
  where: [1, 0, 1],
  set: [3, 2, 3],
  trim: [1, 0, 1],
  identifiers: [1, 0, 1],
  fragments: [1, 0, 1],
};

async function dynamicCases(add, directory) {
  const { emitSource } = await import("@sqlbraid/compiler");
  const source = `import { sql } from '@sqlbraid/template';\n${Object.entries(dynamicBodies)
    .map(
      ([name, body]) =>
        `export function fixture_${name.replaceAll("-", "_")}(enabled, value) { return sql${name === "set" ? ".command" : ".rows"}\`${body}\`; }`,
    )
    .join("\n")}`;
  const emitted = emitSource(source, "micro-fixture.ts", { moduleSpecifier: "@sqlbraid/template" });
  assert.equal(emitted.diagnostics.length, 0, JSON.stringify(emitted.diagnostics));
  await writeFile(join(directory, "runtime.mjs"), source);
  await writeFile(join(directory, "compiled.mjs"), emitted.outputText);
  const runtime = await import(pathToFileURL(join(directory, "runtime.mjs")).href);
  const compiled = await import(pathToFileURL(join(directory, "compiled.mjs")).href);
  const statementView = (query) => {
    const statement = query.render();
    return {
      sql: parameterizedSql(statement, placeholder),
      values: statement.parameters.map(({ value }) => value),
      resultKind: statement.resultKind,
      dialectId: statement.dialectId,
    };
  };
  for (const name of Object.keys(dynamicBodies)) {
    const key = `fixture_${name.replaceAll("-", "_")}`;
    for (const enabled of [false, true]) {
      const group = `micro/dynamic/${name}/${enabled ? "enabled" : "disabled"}`;
      const verify = () => {
        let eager = 0;
        let lazy = 0;
        const runtimeView = statementView(
          runtime[key](enabled, (value) => {
            eager += 1;
            return value;
          }),
        );
        const compiledView = statementView(
          compiled[key](enabled, (value) => {
            lazy += 1;
            return value;
          }),
        );
        assert.deepEqual(compiledView, runtimeView);
        assert.equal(eager, lazyCalls[name][0]);
        assert.equal(lazy, lazyCalls[name][enabled ? 2 : 1]);
        assert.ok(!runtimeView.sql.includes("@braid"));
      };
      for (const [implementation, module] of [
        ["runtime", runtime],
        ["compiled", compiled],
      ]) {
        const build = module[key];
        const query = build(enabled, identity);
        for (const [stage, run] of [
          ["create", () => build(enabled, identity)],
          ["create-render", () => build(enabled, identity).render()],
          ["render-existing", () => query.render()],
        ]) {
          add({
            name: `${group}/${implementation}/${stage}`,
            group,
            implementation: `sqlbraid-${implementation}`,
            category: "micro",
            run,
            async: false,
            verify,
            metadata: {
              stage,
              enabled,
              compilerDuringMeasurement: false,
              eagerExpressions: lazyCalls[name][0],
              compiledExpressions: lazyCalls[name][enabled ? 2 : 1],
            },
          });
        }
      }
    }
  }
}

export async function createSuite({ profile = "full" } = {}) {
  const cases = [];
  const add = (entry) => cases.push(entry);
  const directory = await mkdtemp(join(fileURLToPath(new URL(".", import.meta.url)), ".micro-fixture-"));
  try {
    templateCases(add);
    lifecycleCases(add);
    materializationCases(add, profile);
    await dynamicCases(add, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    cases,
    metadata: {
      network: false,
      compiler:
        "Built @sqlbraid/compiler emitSource runs once during suite setup; measured fixtures are imported JavaScript.",
      cardinalities: profile === "smoke" ? [0, 1, 10] : [0, 1, 10, 100, 1000, 10000],
      isolationLimits: [
        "Postgres internal request materialize, assertUniqueFields, and runtime validateRow are bundled private functions, not stable importable build exports. Executor cases include these stages together.",
        "Public core/driver projector benchmarks use the adapter's actual built projection primitive; prepared projector excludes setup, setup-and-rows includes it. Type-policy-only allocates a positional result to retain every decoded value.",
        "Native fake pg returns preallocated parsed array rows: wire parsing, network I/O, server work, and native driver's per-result allocation are excluded for both adapter and native baseline.",
        "No-validation means no application Standard Schema; runtime result-shape and adapter exactness checks remain enabled.",
        "Schema-only is the same validator without SQLBraid orchestration; runtime validation cases include real pg adapter normalization, runtime scheduling, and per-row Standard Schema processing.",
        "Lifecycle baselines are lower bounds with identical fake resources/results and independent orchestration, not feature-equivalent replacement database implementations.",
      ],
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
