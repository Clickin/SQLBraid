# @sqlbraid/sqlite

SQLite dialect and adapters for various JavaScript environments.

```sh
npm install @sqlbraid/sqlite
```

Depending on your environment, use the matching adapter subpath:

| Subpath           | Physical API        | Key Features                                         |
| :---------------- | :------------------ | :--------------------------------------------------- |
| `/node-sqlite`    | Node `DatabaseSync` | Fast, synchronous physical calls (async public API)  |
| `/better-sqlite3` | `better-sqlite3`    | High-performance, event-loop blocking physical calls |
| `/libsql`         | `@libsql/client`    | Support for Turso and local libSQL                   |
| `/wasm`           | SQLite WASM         | Web and cross-platform support                       |
| `/d1`             | Cloudflare D1       | Native integration for Cloudflare Workers            |

### Key Details

- **Data Types**: Most adapters preserve INTEGER as decimal strings to avoid precision loss.
- **Async API**: All adapters use the same async `Database` API, regardless of whether the underlying driver is synchronous.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
