# @sqlbraid/sqlite

SQLite dialect and adapters for many JavaScript environments.

```sh
pnpm add @sqlbraid/sqlite
```

Use the adapter subpath for your environment. Import `sql` from `@sqlbraid/sqlite`.

| Adapter        | Import path                       | Physical API and notes                                                            |
| :------------- | :-------------------------------- | :-------------------------------------------------------------------------------- |
| Node SQLite    | `@sqlbraid/sqlite/node-sqlite`    | Node `DatabaseSync`; synchronous calls; exact INTEGER strings; native `iterate()` |
| better-sqlite3 | `@sqlbraid/sqlite/better-sqlite3` | Synchronous and event-loop blocking; `safeIntegers(true)`; native iteration       |
| libSQL         | `@sqlbraid/sqlite/libsql`         | `@libsql/client`; requires `intMode: "string"`; no stream fallback                |
| SQLite WASM    | `@sqlbraid/sqlite/wasm`           | SQLite WASM OO1                                                                   |
| Cloudflare D1  | `@sqlbraid/sqlite/d1`             | Cloudflare Workers                                                                |

If the adapter needs an external driver or client, install it separately. `node:sqlite` is part of Node. The Worker runtime supplies Cloudflare D1.

The package root `@sqlbraid/sqlite` gives the SQLite dialect. The optional `@sqlbraid/sqlite/inspector` subpath gives metadata inspection. It requires the optional `@sqlbraid/metadata` peer. It is not a query adapter.

### Key Details

- **Data types**: Exact INTEGER values are decimal strings when the selected adapter supports this. This prevents loss of precision.
- **Async API**: All adapters use the same async `Database` API. This is also true when the driver is synchronous.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

See the [full package map](https://clickin.github.io/SQLBraid/latest/reference/packages/) and [driver support matrix](https://clickin.github.io/SQLBraid/latest/reference/support/).
