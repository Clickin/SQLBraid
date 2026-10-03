# OpenTelemetry slow-query example

This packed example uses PostgreSQL `pg_sleep(...)` to compare a fast operation
and a slow operation. It checks two outputs:

- a plain SQLBraid `query:result` warning;
- the OpenTelemetry in-memory trace and metric exporters that the SDK owns.

The CI example runner supplies `SQLBRAID_POSTGRES_URL`. You do not need a
collector or an external observability backend.
