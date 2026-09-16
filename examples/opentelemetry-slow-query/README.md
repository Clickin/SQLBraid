# OpenTelemetry slow-query example

This packed example uses PostgreSQL `pg_sleep(...)` to compare a fast and slow
operation. It checks a plain SQLBraid `query:result` warning and SDK-owned
OpenTelemetry in-memory trace and metric exporters.

The CI example runner supplies `SQLBRAID_POSTGRES_URL`. No collector or
external observability backend is required.
