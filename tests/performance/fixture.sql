-- This file may only reset the dedicated performance database and its named tables.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'sqlbraid_perf' THEN
    RAISE EXCEPTION 'Performance fixture requires database sqlbraid_perf';
  END IF;
END $$;
DROP TABLE IF EXISTS public.sqlbraid_perf_rows, public.sqlbraid_perf_writes;
CREATE TABLE public.sqlbraid_perf_rows (
  id integer PRIMARY KEY,
  name text NOT NULL,
  c03 integer NOT NULL, c04 integer NOT NULL, c05 integer NOT NULL,
  c06 integer NOT NULL, c07 integer NOT NULL, c08 integer NOT NULL,
  c09 integer NOT NULL, c10 integer NOT NULL, c11 integer NOT NULL,
  c12 integer NOT NULL, c13 integer NOT NULL, c14 integer NOT NULL,
  c15 integer NOT NULL, c16 integer NOT NULL, c17 integer NOT NULL,
  c18 integer NOT NULL, c19 integer NOT NULL, c20 integer NOT NULL,
  c21 integer NOT NULL, c22 integer NOT NULL, c23 integer NOT NULL,
  c24 integer NOT NULL,
  nullable text,
  amount numeric(30, 6),
  big bigint NOT NULL,
  day date,
  at timestamptz,
  payload jsonb NOT NULL,
  active boolean NOT NULL
);
CREATE TABLE public.sqlbraid_perf_writes (
  id integer PRIMARY KEY,
  value integer NOT NULL
);
INSERT INTO public.sqlbraid_perf_rows
SELECT i, 'row-' || lpad(i::text, 5, '0'),
  i+3, i+4, i+5, i+6, i+7, i+8, i+9, i+10, i+11, i+12,
  i+13, i+14, i+15, i+16, i+17, i+18, i+19, i+20, i+21, i+22, i+23, i+24,
  CASE WHEN i % 2 = 0 THEN NULL ELSE 'nullable-' || i END,
  CASE WHEN i % 7 = 0 THEN NULL ELSE 12345678901234567890.123456::numeric + i END,
  9007199254740993::bigint + i,
  CASE WHEN i % 5 = 0 THEN NULL ELSE DATE '2024-01-01' + (i % 365) END,
  CASE WHEN i % 3 = 0 THEN NULL ELSE TIMESTAMPTZ '2024-01-01 00:00:00.123456+00' + i * INTERVAL '1 second' END,
  jsonb_build_object('id', i, 'active', i % 2 = 0, 'tags', jsonb_build_array('a', 'b')),
  i % 2 = 0
FROM generate_series(1, 10000) AS s(i);
INSERT INTO public.sqlbraid_perf_writes VALUES (1, 0);
ANALYZE public.sqlbraid_perf_rows;
ANALYZE public.sqlbraid_perf_writes;
COMMIT;
