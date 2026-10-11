import type { TypePolicy } from "@sqlbraid/core";
import { defineResultProperty, identityResultValue, preparePositionalResultProjector } from "@sqlbraid/core/driver";
import type { RenderedStatement } from "@sqlbraid/core";
import { pgOidTypes } from "../pg/types.js";
import type { PgFieldLike, PgResultLike } from "../pg/types.js";

export function pgDatabaseType(field: PgFieldLike | undefined): string | undefined {
  return field?.dataType ?? (field?.dataTypeID === undefined ? undefined : pgOidTypes[field.dataTypeID]);
}

export function preparePgRowProjector(
  fields: readonly PgFieldLike[],
  policy: TypePolicy,
  rowCountHint?: number,
): (value: unknown) => Record<string, unknown> {
  const columns = fields.map((field, index) => {
    const databaseType = pgDatabaseType(field);
    return {
      name: field.name,
      index,
      decode: databaseType ? (entry: unknown) => policy.decode(databaseType, entry) : identityResultValue,
    };
  });
  const arrayProjector = preparePositionalResultProjector(columns, rowCountHint);
  let objectDecoders: Map<string, (entry: unknown) => unknown> | undefined;
  return (value): Record<string, unknown> => {
    if (Array.isArray(value)) return columns.length === 0 ? { value } : arrayProjector(value);
    if (!value || typeof value !== "object") return { value };
    objectDecoders ??= new Map(columns.map((column) => [column.name, column.decode] as const));
    const row: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineResultProperty(row, key, (objectDecoders.get(key) ?? identityResultValue)(entry));
    }
    return row;
  };
}

export function projectPgRows(
  rows: readonly unknown[],
  fields: readonly PgFieldLike[],
  policy: TypePolicy,
): readonly Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const project = preparePgRowProjector(fields, policy, rows.length);
  return rows.map(project);
}

export function assertUniqueFields(fields: readonly PgFieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name))
      throw new Error(`BRAID_RESULT_COLUMNS: duplicate PostgreSQL result label ${field.name}.`);
    names.add(field.name);
  }
}

export function outputRow(
  result: PgResultLike,
  rendered: RenderedStatement,
  policy: TypePolicy,
): Readonly<Record<string, unknown>> {
  const outputParameters = rendered.parameters.filter(
    (parameter) => parameter.direction !== undefined && parameter.direction !== "in",
  );
  if (outputParameters.length === 0 || result.rows.length === 0) return {};
  const row = result.rows[0];
  if (!row || typeof row !== "object") return {};
  const arrayRow = Array.isArray(row);
  const fields = result.fields ?? [];
  let values: unknown[] | undefined;
  const output: Record<string, unknown> = {};
  let positional = 0;
  for (const parameter of outputParameters) {
    const name = parameter.outputName;
    if (!name) continue;
    const field = fields[positional];
    const source = arrayRow
      ? (row as readonly unknown[])[positional]
      : field === undefined
        ? (values ??= Object.values(row))[positional]
        : Object.hasOwn(row, field.name)
          ? (row as Record<string, unknown>)[field.name]
          : undefined;
    positional += 1;
    const databaseType = pgDatabaseType(field);
    defineResultProperty(output, name, databaseType ? policy.decode(databaseType, source) : source);
  }
  return output;
}

export function quotePortal(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
