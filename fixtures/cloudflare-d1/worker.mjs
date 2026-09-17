import { createD1Database } from "@sqlbraid/sqlite/d1";
import { sql } from "@sqlbraid/sqlite";
import { verifyBulkConformance } from "../bulk-conformance.mjs";
import { assertCertificationCasesPass, certifyTarget } from "../../tests/certification/execute.js";
import { createD1Target } from "../../tests/certification/targets/d1.js";

const jsonText =
  '{"small":42,"largeInteger":9223372036854775807,"highPrecision":12345678901234567890.12345678901234567890,"nested":{"array":[9007199254740993,0.1000000000000000000001]}}';

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/certification") {
      const sourceSha = requestUrl.searchParams.get("sourceSha") ?? "working-tree";
      const stress = requestUrl.searchParams.get("stress") === "1";
      const measuredDriverVersion = requestUrl.searchParams.get("driverVersion");
      const measuredRuntimeVersion = requestUrl.searchParams.get("runtimeVersion");
      if (measuredDriverVersion === null || measuredRuntimeVersion === null)
        throw new Error("D1 certification requires measured driver and workerd versions.");
      const target = createD1Target(env.DB, sourceSha, { measuredDriverVersion, measuredRuntimeVersion });
      const artifact = await certifyTarget(target, { stress });
      assertCertificationCasesPass(artifact.cases);
      return Response.json({ artifact });
    }
    let nativeBatchCalls = 0;
    let prepareCalls = 0;
    const binding = {
      prepare(text) {
        prepareCalls += 1;
        return env.DB.prepare(text);
      },
      batch(statements) {
        nativeBatchCalls += 1;
        return env.DB.batch(statements);
      },
    };
    const events = [];
    const db = createD1Database(binding, {
      observers: [
        {
          onEvent(event) {
            events.push(event);
          },
        },
      ],
    });
    const conformanceReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "sqlite",
      expectedMode: "remote-batch",
      events,
      transactions: false,
    });
    const bulkOperationCount = events.filter((event) => event.type === "bulk:ready").length;
    if (nativeBatchCalls !== bulkOperationCount) {
      throw new Error(
        `D1 bulk conformance expected one native batch call per bulk operation (${bulkOperationCount}), received ${nativeBatchCalls}.`,
      );
    }
    const bulkConformance = { ...conformanceReport, nativeBatchCalls, bulkOperationCount };
    const beforeUsersBulk = nativeBatchCalls;
    await db.execute(
      sql.command`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload BLOB)`,
    );
    const inserted = await db.execute(
      sql.rows`INSERT INTO users (name, payload) VALUES (${"Ada"}, ${new Uint8Array([1, 2, 3])}) RETURNING id, name, payload`,
    );
    if (typeof inserted.rows[0]?.id !== "string")
      throw new Error("D1 INTEGER RETURNING values must remain canonical text.");
    const bulk = await db.bulk(["Grace", "Lin"], (name) => sql.command`INSERT INTO users (name) VALUES (${name})`);
    if (nativeBatchCalls !== beforeUsersBulk + 1) throw new Error("D1 users bulk did not use one native batch call.");
    const rows = await db.all(sql.rows`SELECT id, name, payload FROM users ORDER BY id`);
    if (rows.some((row) => typeof row.id !== "string")) throw new Error("D1 INTEGER rows must remain canonical text.");
    const transparencyQuery = sql.rows`
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             json_extract('{"enabled":true}', '$.enabled') AS enabled,
             ${7} AS actual
    `;
    const transparency = await db.all(transparencyQuery);
    const transparencySql = events.findLast((event) => event.type === "query:ready")?.sql;
    const transparencySegments = transparencyQuery.render().segments;
    const generatedQuery = sql.rows`SELECT ${sql.ident("value")} FROM (SELECT ${8} AS value)`;
    const generated = await db.all(generatedQuery);
    const generatedSql = events.findLast((event) => event.type === "query:ready")?.sql;
    const numeric = await db.one(sql.rows`
      SELECT CAST('9007199254740991' AS INTEGER) AS safe
    `);
    if (numeric.safe !== "9007199254740991") throw new Error("D1 safe INTEGER must remain canonical text.");
    const integralReal = await db.one(sql.rows`SELECT CAST(1 AS REAL) AS value`);
    if (integralReal.value !== "1") throw new Error("D1 integral REAL must follow its guarded numeric profile.");
    let unsafeCode;
    try {
      await db.one(sql.rows`SELECT CAST('9007199254740992' AS INTEGER) AS unsafe`);
    } catch (error) {
      unsafeCode =
        error?.code ?? (/BRAID_INTEGER_UNSAFE/u.test(error?.message ?? "") ? "BRAID_INTEGER_UNSAFE" : undefined);
    }
    if (unsafeCode !== "BRAID_INTEGER_UNSAFE") throw new Error("D1 out-of-range INTEGER must fail closed.");
    const json = await db.one(sql.rows`
      SELECT ${jsonText} AS payload,
             json_extract('{"enabled":true}', '$.enabled') AS enabled
    `);
    if (json.payload !== jsonText || json.enabled !== "1") throw new Error("D1 JSON text fidelity changed.");
    const beforeUnsupported = prepareCalls;
    let sessionCode;
    try {
      await db.session(async (scoped) => scoped.all(sql.rows`SELECT 1 AS value`));
    } catch (error) {
      sessionCode = error?.code;
    }
    if (prepareCalls !== beforeUnsupported) throw new Error("D1 unsupported session acquired or prepared a statement.");
    const beforeCancel = prepareCalls;
    let cancelCode;
    const active = new AbortController();
    try {
      await db.all(sql.rows`SELECT 1 AS value`, { signal: active.signal });
    } catch (error) {
      cancelCode = error?.code;
    }
    if (prepareCalls !== beforeCancel) throw new Error("D1 unsupported active cancellation prepared a statement.");
    const session = createD1Database(env.DB.withSession("first-primary"));
    await session.bulk(["Session"], (name) => sql.command`INSERT INTO users (name) VALUES (${name})`);
    const sessionRows = await session.all(sql.rows`SELECT name FROM users WHERE name = ${"Session"}`);
    const schema = {
      "~standard": {
        version: 1,
        vendor: "sqlbraid-d1-fixture",
        validate: (row) => ({
          value: { ...row, name: row.name.toUpperCase(), profile: JSON.parse(row.profile), payload: [...row.payload] },
        }),
      },
    };
    const mappedQuery = db.prepare(
      "mapped-user",
      () => sql.rows(schema)`
      SELECT id, name, payload, '{"active":true}' AS profile,
             '2026-09-14T00:00:00.123456Z' AS stamp,
             '123e4567-e89b-12d3-a456-426614174000' AS uuid
      FROM users WHERE id = ${1}
    `,
    );
    const mapped = (await mappedQuery.execute()).rows;
    const updated = await db.all(sql.rows`UPDATE users SET name = ${"Updated"} WHERE id = 1 RETURNING id, name`);
    const deleted = await db.all(sql.rows`DELETE FROM users WHERE id = 1 RETURNING id`);
    let streamCode;
    try {
      for await (const _row of db.stream(sql.rows`SELECT id FROM users`)) void _row;
    } catch (error) {
      streamCode = error?.code;
    }
    let transactionCode;
    try {
      await db.tx(async () => undefined);
    } catch (error) {
      transactionCode = error?.code;
    }
    return Response.json({
      inserted: { kind: inserted.kind, rows: inserted.rows.map((row) => ({ ...row, payload: [...row.payload] })) },
      bulk,
      bulkConformance,
      sessionRows,
      rows: rows.map((row) => ({ ...row, payload: row.payload ? [...row.payload] : null })),
      transparency,
      transparencySql,
      transparencySegments,
      generated,
      generatedSql,
      generatedSegments: generatedQuery.render().segments,
      mapped,
      updated,
      deleted,
      environment: await db.environment(),
      numeric: { ...numeric, integralReal, unsafeCode },
      json,
      sessionCode,
      cancelCode,
      streamCode,
      transactionCode,
    });
  },
};
