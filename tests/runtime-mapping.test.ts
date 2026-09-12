import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';
import type { QueryExecutor, StandardSchemaV1 } from '@sqlbraid/core';
import { sql } from '@sqlbraid/template';
import { createDatabase, DatabaseResultValidationError } from '@sqlbraid/runtime';

function rowsExecutor(rows: readonly unknown[]): QueryExecutor {
  return {
    async query<Row>() {
      return { kind: 'rows' as const, rows: rows as readonly Row[] };
    },
  };
}

test('Valibot schemas map normalized database rows without an adapter', async () => {
  const schema = v.pipe(
    v.object({
      createdAt: v.string(),
      payload: v.string(),
    }),
    v.transform((row) => ({
      ...row,
      createdAt: new Date(
        `${row.createdAt.slice(0, 4)}-${row.createdAt.slice(4, 6)}-${row.createdAt.slice(6, 8)}T${row.createdAt.slice(8, 10)}:${row.createdAt.slice(10, 12)}:${row.createdAt.slice(12, 14)}Z`,
      ),
      payload: JSON.parse(row.payload) as { readonly enabled: boolean },
    })),
  );
  const db = createDatabase(rowsExecutor([{
    createdAt: '20260912191500',
    payload: '{"enabled":true}',
  }]));

  const result = await db.all(sql.rows(schema)`SELECT created_at, payload`);
  assert.equal(result.length, 1);
  assert.equal(result[0].createdAt.toISOString(), '2026-09-12T19:15:00.000Z');
  assert.deepEqual(result[0].payload, { enabled: true });
});

test('Zod schemas validate, transform, and report Standard Schema failures directly', async () => {
  const schema = z.object({ id: z.number() }).transform(({ id }) => ({ id, label: `user-${id}` }));
  const db = createDatabase(rowsExecutor([{ id: 4 }]));
  assert.deepEqual(await db.execute(sql.rows(schema)`SELECT id`), {
    kind: 'rows',
    rows: [{ id: 4, label: 'user-4' }],
  });

  const invalid = z.object({ id: z.number() }).transform(({ id }) => ({ id }));
  const failing = createDatabase(rowsExecutor([{ id: 'not-a-number' }]));
  await assert.rejects(
    () => failing.all(sql.rows(invalid)`SELECT id`),
    (error: unknown) => error instanceof DatabaseResultValidationError
      && error.code === 'BRAID_RESULT_VALIDATION'
      && error.stage === 'query'
      && error.rowIndex === 0
      && error.issues.length > 0,
  );
});

test('a handwritten Standard Schema fixture is sufficient for mapping', async () => {
  const schema: StandardSchemaV1<unknown, { readonly id: number; readonly accepted: true }> = {
    '~standard': {
      version: 1 as const,
      vendor: 'handwritten-test',
      validate(value: unknown) {
        if (value === null || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number') {
          return { issues: [{ message: 'id must be a number' }] };
        }
        return { value: { id: value.id, accepted: true as const } };
      },
    },
  };
  const db = createDatabase(rowsExecutor([{ id: 8 }]));
  assert.deepEqual(await db.one(sql.rows(schema)`SELECT id`), { id: 8, accepted: true });
});
