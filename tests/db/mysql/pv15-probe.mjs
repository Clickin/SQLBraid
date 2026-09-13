import mysql from "mysql2/promise";

const connection = await mysql.createConnection({
  uri: process.env.MYSQL_URL ?? "mysql://sqlbraid:sqlbraid@127.0.0.1:33306/sqlbraid",
  multipleStatements: true,
});
try {
  await connection.query("DROP PROCEDURE IF EXISTS braid_pv15_probe");
  await connection.query(`
    CREATE PROCEDURE braid_pv15_probe(IN p INT, OUT p_out INT, INOUT p_io INT)
    BEGIN
      SELECT p AS shape_a;
      SELECT p + 1 AS shape_b;
      SET p_out = p * 2;
      SET p_io = p_io + 3;
    END
  `);
  const [payload, fields] = await connection.execute("CALL braid_pv15_probe(?, ?, ?)", [7, null, 10]);
  const summary = {
    payloadType: Array.isArray(payload) ? "array" : typeof payload,
    payloadLength: Array.isArray(payload) ? payload.length : undefined,
    payloadEntries: Array.isArray(payload) ? payload.map((entry, index) => ({
      index,
      type: Array.isArray(entry) ? "rows" : typeof entry,
      length: Array.isArray(entry) ? entry.length : undefined,
      keys: entry && typeof entry === "object" && !Array.isArray(entry) ? Object.keys(entry) : undefined,
      value: entry && typeof entry === "object" && !Array.isArray(entry) ? {
        fieldCount: entry.fieldCount,
        affectedRows: entry.affectedRows,
        serverStatus: entry.serverStatus,
        warningStatus: entry.warningStatus,
      } : undefined,
      first: Array.isArray(entry) ? entry[0] : undefined,
    })) : undefined,
    fieldsType: Array.isArray(fields) ? "array" : typeof fields,
    fieldsLength: Array.isArray(fields) ? fields.length : undefined,
    fieldsEntries: Array.isArray(fields) ? fields.map((entry, index) => ({
      index,
      type: Array.isArray(entry) ? "fields" : typeof entry,
      length: Array.isArray(entry) ? entry.length : undefined,
      names: Array.isArray(entry) ? entry.map((field) => field.name) : undefined,
      keys: entry && typeof entry === "object" && !Array.isArray(entry) ? Object.keys(entry) : undefined,
    })) : undefined,
  };
  console.log(JSON.stringify(summary, (_, value) => typeof value === "bigint" ? `${value}n` : value, 2));
} finally {
  await connection.query("DROP PROCEDURE IF EXISTS braid_pv15_probe").catch(() => undefined);
  await connection.end();
}
