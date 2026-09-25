# @sqlbraid/sqlite

SQLite dialect and adapters for various JavaScript environments.

```sh
npm install @sqlbraid/sqlite
```

Use the adapter subpath for your environment. The granular package paths and their `sqlbraid` facade equivalents are:

| Adapter        | `@sqlbraid/sqlite` import         | `sqlbraid` facade import  | Physical API and notes                                                            |
| :------------- | :-------------------------------- | :------------------------ | :-------------------------------------------------------------------------------- |
| Node SQLite    | `@sqlbraid/sqlite/node-sqlite`    | `sqlbraid/node-sqlite`    | Node `DatabaseSync`; synchronous calls; exact INTEGER strings; native `iterate()` |
| better-sqlite3 | `@sqlbraid/sqlite/better-sqlite3` | `sqlbraid/better-sqlite3` | Synchronous and event-loop blocking; `safeIntegers(true)`; native iteration       |
| libSQL         | `@sqlbraid/sqlite/libsql`         | `sqlbraid/libsql`         | `@libsql/client`; requires `intMode: "string"`; no stream fallback                |
| SQLite WASM    | `@sqlbraid/sqlite/wasm`           | `sqlbraid/sqlite-wasm`    | SQLite WASM OO1                                                                   |
| Cloudflare D1  | `@sqlbraid/sqlite/d1`             | `sqlbraid/d1`             | Cloudflare Workers                                                                |

Install the selected external driver or client separately when required. Node's `node:sqlite` is built in; Cloudflare D1 is provided by the Worker runtime.

The package root `@sqlbraid/sqlite` provides the SQLite dialect. Its optional `@sqlbraid/sqlite/inspector` subpath provides metadata inspection and requires the optional `@sqlbraid/metadata` peer; it is not a query adapter.

### Key Details

- **Data Types**: Exact INTEGER values are exposed as decimal strings to avoid precision loss where supported by the selected adapter.
- **Async API**: All adapters use the same async `Database` API, even when the underlying driver is synchronous.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

See the [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) and [driver support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/).
