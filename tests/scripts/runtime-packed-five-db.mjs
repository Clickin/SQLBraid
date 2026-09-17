#!/usr/bin/env node
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { Connection } from "tedious";
import { createOracledbDatabase, createOracledbPoolDatabase } from "@sqlbraid/oracle/oracledb";
import { createOracleInspector } from "@sqlbraid/oracle/inspector";
import { oracleParameter, sql as oracle } from "@sqlbraid/oracle";
import { createTediousDatabase, createTediousPoolDatabase } from "@sqlbraid/mssql/tedious";
import { createMssqlInspector } from "@sqlbraid/mssql/inspector";
import { mssqlParameter, sql as mssql } from "@sqlbraid/mssql";

function parseOracleConfig(value) {
  const url = value.includes("://") ? new URL(value) : new URL(`oracle://${value}`);
  const service = url.pathname.replace(/^\//u, "") || "FREEPDB1";
  return {
    user: decodeURIComponent(url.username || process.env.SQLBRAID_ORACLE_USER || "sqlbraid"),
    password: decodeURIComponent(url.password || process.env.SQLBRAID_ORACLE_PASSWORD || "SqlbraidTest13"),
    connectString: `${url.hostname}:${url.port || "1521"}/${service}`,
  };
}

function parseMssqlConfig(value) {
  const url = value.includes("://") ? new URL(value) : new URL(`sqlserver://${value}`);
  const password = decodeURIComponent(url.password || process.env.SQLBRAID_MSSQL_PASSWORD || "Sqlbraid_Test13!");
  return {
    server: url.hostname,
    options: {
      port: Number(url.port || 1433),
      database: decodeURIComponent(url.pathname.replace(/^\//u, "")) || "master",
      trustServerCertificate: true,
      encrypt: false,
    },
    authentication: {
      type: "default",
      options: {
        userName: decodeURIComponent(url.username || process.env.SQLBRAID_MSSQL_USER || "sa"),
        password,
      },
    },
  };
}

function connectTedious(config) {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);
    const onError = (error) => {
      connection.removeListener("connect", onConnect);
      reject(error);
    };
    const onConnect = (error) => {
      connection.removeListener("error", onError);
      if (error) reject(error);
      else resolve(connection);
    };
    connection.once("error", onError);
    connection.once("connect", onConnect);
    connection.connect();
  });
}

function closeTedious(connection) {
  return new Promise((resolve) => {
    connection.once("end", resolve);
    connection.close();
  });
}

export async function runOracleSmoke(value) {
  if (!value)
    throw new Error("SQLBRAID_ORACLE_URL is required for the packed Oracle gate or must be provisioned by the caller.");
  const config = parseOracleConfig(value);
  const connection = await oracledb.getConnection(config);
  const table = `SQLBRAID_PACKED_${Date.now().toString(36).toUpperCase()}`;
  try {
    const database = createOracledbDatabase(connection, { driver: oracledb });
    const rows = await database.all(oracle.rows`SELECT 1 AS ID FROM DUAL`);
    assert.deepEqual(rows, [{ ID: "1" }]);
    const typed = await database.all(oracle.rows`SELECT ${oracle.bind(7, oracleParameter.number())} AS ID FROM DUAL`);
    assert.equal(typed[0]?.ID, "7");
    await database.execute(
      oracle.command`CREATE TABLE ${oracle.ident(table)} (ID NUMBER PRIMARY KEY, LABEL VARCHAR2(40))`,
    );
    await database.tx(async (tx) => {
      await tx.execute(oracle.command`INSERT INTO ${oracle.ident(table)} (ID, LABEL) VALUES (${1}, ${"packed"})`);
    });
    const pool = await oracledb.createPool(config);
    try {
      const pooled = createOracledbPoolDatabase(pool, { driver: oracledb });
      const pooledRows = await pooled.all(oracle.rows`SELECT LABEL FROM ${oracle.ident(table)}`);
      assert.deepEqual(pooledRows, [{ LABEL: "packed" }]);
    } finally {
      await pool.close(0);
    }
    const metadata = await createOracleInspector(connection).inspect();
    assert.ok(Object.values(metadata.relations).some((relation) => relation.name === table));
  } finally {
    try {
      await connection.execute(`DROP TABLE "${table}" PURGE`);
    } catch {
    } finally {
      await connection.close();
    }
  }
  console.info("PASS packed Oracle adapter/pool/inspector");
}

export async function runMssqlSmoke(value) {
  if (!value)
    throw new Error("SQLBRAID_MSSQL_URL is required for the packed MSSQL gate or must be provisioned by the caller.");
  const config = parseMssqlConfig(value);
  const connection = await connectTedious(config);
  const table = `SQLBraidPacked_${Date.now().toString(36)}`;
  const database = createTediousDatabase(connection);
  try {
    const rows = await database.all(mssql.rows`SELECT 1 AS id`);
    assert.deepEqual(rows, [{ id: "1" }]);
    const typed = await database.all(mssql.rows`SELECT ${mssql.bind("packed", mssqlParameter.nvarchar(40))} AS label`);
    assert.deepEqual(typed, [{ label: "packed" }]);
    await database.execute(
      mssql.command`CREATE TABLE ${mssql.ident(["dbo", table])} (id int NOT NULL, label nvarchar(40) NOT NULL)`,
    );
    await database.tx(async (tx) => {
      await tx.execute(
        mssql.command`INSERT INTO ${mssql.ident(["dbo", table])} (id, label) VALUES (${1}, ${"packed"})`,
      );
    });
    const pool = {
      async acquire() {
        const pooledConnection = await connectTedious(config);
        return Object.assign(pooledConnection, { release: () => closeTedious(pooledConnection) });
      },
    };
    const pooled = createTediousPoolDatabase(pool);
    const pooledRows = await pooled.all(mssql.rows`SELECT id, label FROM ${mssql.ident(["dbo", table])}`);
    assert.deepEqual(pooledRows, [{ id: "1", label: "packed" }]);
    const metadata = await createMssqlInspector(connection).inspect();
    assert.ok(Object.values(metadata.relations).some((relation) => relation.name === table));
  } finally {
    try {
      await database.execute(mssql.command`DROP TABLE ${mssql.ident(["dbo", table])}`);
    } catch {}
    await closeTedious(connection);
  }
  console.info("PASS packed MSSQL adapter/pool/inspector");
}

if (process.argv[1]?.endsWith("runtime-packed-five-db.mjs")) {
  const oracleUrl =
    process.env.SQLBRAID_ORACLE_URL ?? process.env.SQLBRAID_ORACLE_CONNECTION_STRING ?? process.env.ORACLE_URL;
  const mssqlUrl =
    process.env.SQLBRAID_MSSQL_URL ??
    (process.env.SQLBRAID_MSSQL_SERVER
      ? `mssql://${encodeURIComponent(process.env.SQLBRAID_MSSQL_USER ?? "sa")}:${encodeURIComponent(process.env.SQLBRAID_MSSQL_PASSWORD ?? "Sqlbraid_Test13!")}@${process.env.SQLBRAID_MSSQL_SERVER}:${process.env.SQLBRAID_MSSQL_PORT ?? "1433"}/${process.env.SQLBRAID_MSSQL_DATABASE ?? "master"}`
      : undefined);
  await runOracleSmoke(oracleUrl);
  await runMssqlSmoke(mssqlUrl);
}
