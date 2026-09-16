# @sqlbraid/sqlite

SQLite dialect and adapters for Node `node:sqlite`, `better-sqlite3`, libSQL,
official SQLite WASM, and Cloudflare D1.

```sh
npm install @sqlbraid/sqlite
```

The application creates and owns the database or Worker binding, then uses the
matching adapter subpath:

| Subpath | Physical API | Semantics |
| --- | --- | --- |
| `/node-sqlite` | Node `DatabaseSync` / `StatementSync` | synchronous physical calls behind the async public API; exact INTEGER strings, native iteration, prepared-loop bulk |
| `/better-sqlite3` | `better-sqlite3` database/statements | synchronous and event-loop-blocking physical calls; statement-local `safeIntegers(true)`, native iteration, prepared-loop bulk |
| `/libsql` | `@libsql/client` | requires an explicit `intMode: "string"` assertion; interactive transaction handles, remote batch, no pinned session or stream fallback |
| `/wasm` | SQLite WASM OO1 | synchronous OO1 calls with an async-generator stream adapter |
| `/d1` | Cloudflare D1 | prepared binds; no streaming or callback transactions |

Node requires `node:sqlite` from Node 22.18 or newer. The Node,
better-sqlite3, libSQL exact-string, and WASM adapters preserve INTEGER values
as decimal strings, REAL as numbers, TEXT as strings, and binary values as
portable bytes. D1 cannot guarantee full SQLite int64 fidelity and does not
provide streaming or callback transactions.

All adapters retain SQLBraid's async `Database` API. `Awaitable<T>` is only an
SPI affordance for synchronous physical query, bulk, and transaction-control
methods; it does not make `better-sqlite3` non-blocking. Native SQLite SQL is
passed through without grammar rewriting, which is transport transparency and
not a promise that SQLBraid supports every SQLite extension.

The libSQL adapter accepts clients whose documented integer mode is explicitly
asserted with `{ intMode: "string" }`. It uses the client's `execute`,
`batch`, and interactive `transaction()` handle; ordinary client calls do not
prove one pinned session, and `db.stream()` fails with
`BRAID_STREAM_UNSUPPORTED` rather than buffering a result set. `readOnly: true`
maps to libSQL's documented read transaction mode; SQLBraid isolation literals
are rejected when no exact equivalent is documented.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
