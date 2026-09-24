import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const rowCount = Number(process.env.ROWS ?? 25_000);
const rounds = Number(process.env.ROUNDS ?? 5);
const specialNames = ["__proto__", "constructor", "prototype", "2", "患者🩺", "regular"];
const postgresTypes = {
  16: "bool",
  17: "bytea",
  20: "int8",
  25: "text",
  701: "float8",
  114: "json",
  1700: "numeric",
};
const valuesByType = [
  "patient-name",
  "12345678901234567890.123456789",
  "9007199254740993",
  1.25,
  null,
  new Uint8Array([1, 2, 3]),
  { ok: true, count: 4 },
];
const policy = {
  decode(databaseType, value) {
    if ((databaseType === "numeric" || databaseType === "int8") && value !== null && typeof value !== "string") {
      throw new Error("Exact numeric value was not text: " + databaseType);
    }
    return value;
  },
};
const defineResultProperty = (row, key, value) =>
  Object.defineProperty(row, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });

function makeFixture(columnCount) {
  const fields = Array.from({ length: columnCount }, (_, index) => ({
    name: specialNames[index] ?? "column_" + index,
    dataTypeID: [25, 1700, 20, 701, 16, 17, 114][index % 7],
  }));
  const values = fields.map((_, index) => valuesByType[index % 7]);
  const rawArrayRows = Array.from({ length: rowCount }, () => values);
  const objectRow = {};
  fields.forEach((field, index) => defineResultProperty(objectRow, field.name, values[index]));
  const rawObjectRows = Array.from({ length: rowCount }, () => objectRow);
  const preparedColumns = fields.map((field, index) => {
    const databaseType =
      field.dataType ?? (field.dataTypeID === undefined ? undefined : postgresTypes[field.dataTypeID]);
    return {
      index,
      name: field.name,
      read: databaseType ? (raw) => policy.decode(databaseType, raw) : (raw) => raw,
    };
  });
  const template = {};
  for (const column of preparedColumns) {
    if (!Object.hasOwn(template, column.name)) defineResultProperty(template, column.name, undefined);
  }
  return { fields, rawArrayRows, rawObjectRows, preparedColumns, template };
}

function materializePostgresObject(row, fields) {
  const output = {};
  for (const [key, entry] of Object.entries(row)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType =
      field?.dataType ?? (field?.dataTypeID === undefined ? undefined : postgresTypes[field.dataTypeID]);
    defineResultProperty(output, key, databaseType ? policy.decode(databaseType, entry) : entry);
  }
  return output;
}

function materializeArrayDefine(values, columns) {
  const output = {};
  for (const column of columns) defineResultProperty(output, column.name, column.read(values[column.index]));
  return output;
}

function materializeArrayAssignment(values, columns) {
  const output = {};
  for (const column of columns) {
    const value = column.read(values[column.index]);
    if (column.name === "__proto__") defineResultProperty(output, column.name, value);
    else output[column.name] = value;
  }
  return output;
}

function materializeTemplate(values, columns, template) {
  const output = { ...template };
  for (const column of columns) output[column.name] = column.read(values[column.index]);
  return output;
}

function prepareProjector(columns, template) {
  const prepared = columns.map((column) => ({ name: column.name, index: column.index, read: column.read }));
  return (values) => {
    const output = { ...template };
    for (const column of prepared) output[column.name] = column.read(values[column.index]);
    return output;
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function runRows(materialize, rawRows) {
  const output = new Array(rawRows.length);
  for (let index = 0; index < rawRows.length; index += 1) output[index] = materialize(rawRows[index]);
  return output;
}

function measure(materialize, rawRows) {
  const start = performance.now();
  const output = runRows(materialize, rawRows);
  const elapsedMs = performance.now() - start;
  const sample = output[Math.floor(output.length / 2)];
  assert.equal(Object.getPrototypeOf(sample), Object.prototype);
  assert.equal(Object.hasOwn(sample, "__proto__"), true);
  assert.equal(sample["__proto__"], valuesByType[0]);
  assert.equal(sample.constructor, valuesByType[1]);
  assert.equal(sample.prototype, valuesByType[2]);
  return { output, rowsPerSecond: (rawRows.length * 1000) / elapsedMs };
}

const results = [];
for (const columnCount of [4, 16, 64]) {
  const fixture = makeFixture(columnCount);
  const projector = prepareProjector(fixture.preparedColumns, fixture.template);
  const cases = [
    ["postgres-object-current", (row) => materializePostgresObject(row, fixture.fields), fixture.rawObjectRows],
    ["array-defineProperty", (row) => materializeArrayDefine(row, fixture.preparedColumns), fixture.rawArrayRows],
    ["array-safe-assignment", (row) => materializeArrayAssignment(row, fixture.preparedColumns), fixture.rawArrayRows],
    [
      "template-copy",
      (row) => materializeTemplate(row, fixture.preparedColumns, fixture.template),
      fixture.rawArrayRows,
    ],
    ["prepared-projector", projector, fixture.rawArrayRows],
  ];
  for (const [, run, input] of cases) runRows(run, input.slice(0, 1_000));
  const samples = new Map(cases.map(([name]) => [name, []]));
  for (let round = 0; round < rounds; round += 1) {
    for (let offset = 0; offset < cases.length; offset += 1) {
      const [name, run, input] = cases[(round + offset) % cases.length];
      if (global.gc) global.gc();
      const result = measure(run, input);
      samples.get(name).push(result.rowsPerSecond);
      result.output = undefined;
    }
  }
  const propertyBaseline = median(samples.get("array-defineProperty"));
  const postgresBaseline = median(samples.get("postgres-object-current"));
  for (const [implementation, values] of samples) {
    const rowsPerSecond = median(values);
    results.push({
      columns: columnCount,
      implementation,
      rowsPerSecond: Math.round(rowsPerSecond),
      relativeToArrayDefineProperty: Number((rowsPerSecond / propertyBaseline).toFixed(2)),
      relativeToPostgresObjectCurrent: Number((rowsPerSecond / postgresBaseline).toFixed(2)),
    });
  }
}

console.log(JSON.stringify({ node: process.version, rows: rowCount, rounds, results }, null, 2));
