import assert from "node:assert/strict";
import oracledb from "oracledb";
import { inject, test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";
import { runStreamingConformance } from "../../streaming-conformance.js";

function rowSchema<Output>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv15-oracle",
      validate,
    },
  };
}

async function connect() {
  const settings = inject("oracle");
  const connection = await oracledb.getConnection({
    user: process.env.SQLBRAID_ORACLE_USER ?? "sqlbraid",
    password: process.env.SQLBRAID_ORACLE_PASSWORD ?? "SqlbraidTest13",
    connectString: settings.connectionUri,
  });
  return { connection, settings };
}

test(
  "Oracle routine fixture exposes scalar and two heterogeneous REF CURSOR outputs",
  { timeout: 30_000 },
  async () => {
    const { connection } = await connect();
    try {
      await connection.execute(
        "CREATE OR REPLACE PROCEDURE braid_pv15_routine (p_answer OUT NUMBER, p_users OUT SYS_REFCURSOR, p_payments OUT SYS_REFCURSOR) IS l_implicit SYS_REFCURSOR; BEGIN p_answer := 42; OPEN p_users FOR SELECT 'user-1' AS USER_ID FROM dual; OPEN p_payments FOR SELECT 7 AS PAYMENT_ID FROM dual; OPEN l_implicit FOR SELECT 'summary-1' AS SUMMARY FROM dual; DBMS_SQL.RETURN_RESULT(l_implicit); END;",
      );
      const db = createOracledbDatabase(connection);
      const query = sql.call`BEGIN braid_pv15_routine(${sql.out("answer", oracleParameter.number())}, ${sql.out("users", oracleParameter.refCursor())}, ${sql.out("payments", oracleParameter.refCursor())}); END;`;
      const result = await db.call(query);
      assert.deepEqual(result.output, { answer: "42" });
      assert.deepEqual(
        result.resultSets.map((set) => set.rows),
        [[{ USER_ID: "user-1" }], [{ PAYMENT_ID: "7" }], [{ SUMMARY: "summary-1" }]],
      );
      assert.equal(
        result.resultSets.some((set) => "source" in set),
        false,
      );
    } finally {
      await connection.execute("DROP PROCEDURE braid_pv15_routine").catch(() => undefined);
      await connection.close();
    }
  },
);

test("Oracle routine materializes CLOB and BLOB OUT and INOUT binds", { timeout: 60_000 }, async () => {
  const { connection } = await connect();
  const fill = async (
    lob: NodeJS.WritableStream & {
      once(event: string, listener: (...args: readonly unknown[]) => void): unknown;
      end(value: string | Uint8Array): void;
    },
    value: string | Uint8Array,
  ): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      lob.once("error", reject);
      lob.once("finish", resolve);
      lob.end(value);
    });
  };
  let clobInput: oracledb.Lob | undefined;
  let blobInput: oracledb.Lob | undefined;
  try {
    await connection.execute(
      "CREATE OR REPLACE PROCEDURE braid_pv15_lob (p_clob_out OUT CLOB, p_blob_out OUT BLOB, p_clob_io IN OUT CLOB, p_blob_io IN OUT BLOB) IS l_blob_suffix RAW(32) := UTL_RAW.CAST_TO_RAW('-blob-updated'); BEGIN p_clob_out := TO_CLOB('clob-out'); p_blob_out := TO_BLOB(UTL_RAW.CAST_TO_RAW('blob-out')); DBMS_LOB.WRITEAPPEND(p_clob_io, LENGTH('-clob-updated'), '-clob-updated'); DBMS_LOB.WRITEAPPEND(p_blob_io, UTL_RAW.LENGTH(l_blob_suffix), l_blob_suffix); END;",
    );
    clobInput = await connection.createLob(oracledb.CLOB);
    blobInput = await connection.createLob(oracledb.BLOB);
    await fill(clobInput, "clob-in");
    await fill(blobInput, Buffer.from("blob-in"));
    const db = createOracledbDatabase(connection);
    const query = sql.call`BEGIN braid_pv15_lob(${sql.out("clobOut", oracleParameter.clob())}, ${sql.out("blobOut", oracleParameter.blob())}, ${sql.inOut("clobIo", clobInput, oracleParameter.clob())}, ${sql.inOut("blobIo", blobInput, oracleParameter.blob())}); END;`;
    const result = await db.call(query);
    assert.equal(result.output.clobOut, "clob-out");
    assert.equal(new TextDecoder().decode(result.output.blobOut as Uint8Array), "blob-out");
    assert.equal(result.output.clobIo, "clob-in-clob-updated");
    assert.equal(new TextDecoder().decode(result.output.blobIo as Uint8Array), "blob-in-blob-updated");
    assert.equal(typeof (result.output.clobOut as { readonly getData?: unknown }).getData, "undefined");
    assert.equal(typeof (result.output.blobOut as { readonly getData?: unknown }).getData, "undefined");
  } finally {
    clobInput?.destroy();
    blobInput?.destroy();
    await connection.execute("DROP PROCEDURE braid_pv15_lob").catch(() => undefined);
    await connection.close();
  }
});

test("Oracle real streaming closes cursors on every lifecycle path", { timeout: 120_000 }, async () => {
  let runs = 0;
  const expected = [{ VALUE: "1" }, { VALUE: "2" }, { VALUE: "3" }] as const;
  const schema = rowSchema<{ readonly VALUE: string }>((value) => {
    if (!value || typeof value !== "object" || !("VALUE" in value) || typeof value.VALUE !== "string") {
      return { issues: [{ message: "invalid Oracle conformance row" }] };
    }
    return { value: { VALUE: value.VALUE } };
  });
  const mapping = rowSchema<never>(() => ({ issues: [{ message: "query-bound mapper failed" }] }));
  await runStreamingConformance(
    async () => {
      runs += 1;
      const { connection } = await connect();
      return {
        db: createOracledbDatabase(connection, { streamFetchSize: 2 }),
        query: sql.rows(schema)`SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3`,
        expected,
        mappingQuery: sql.rows(mapping)`SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 3`,
        close: () => connection.close(),
      };
    },
    { abortError: new Error("oracle real stream aborted") },
  );
  assert.equal(runs, 8);
});

test(
  "Oracle transaction streams retain the pinned physical session until iterator cleanup",
  { timeout: 30_000 },
  async () => {
    const { connection } = await connect();
    try {
      const db = createOracledbDatabase(connection);
      const query = sql.rows<{
        readonly VALUE: string;
      }>`SELECT TO_CHAR(LEVEL) AS VALUE FROM dual CONNECT BY LEVEL <= 2`;
      await db.tx(async (tx) => {
        const iterator = tx.stream(query)[Symbol.asyncIterator]();
        assert.equal((await iterator.next()).value?.VALUE, "1");
        await assert.rejects(() => tx.one(sql.rows<{ readonly VALUE: string }>`SELECT TO_CHAR(7) AS VALUE FROM dual`), {
          code: "BRAID_STREAM_SCOPE",
        });
        await iterator.return?.();
        assert.equal(
          (await tx.one(sql.rows<{ readonly VALUE: string }>`SELECT TO_CHAR(7) AS VALUE FROM dual`)).VALUE,
          "7",
        );
      });
    } finally {
      await connection.close();
    }
  },
);
