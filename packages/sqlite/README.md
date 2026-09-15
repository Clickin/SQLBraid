# @sqlbraid/sqlite

SQLite dialect and adapters for Node `node:sqlite`, official SQLite WASM, and
Cloudflare D1.

```sh
npm install @sqlbraid/sqlite
```

The application creates and owns the database or Worker binding, then uses
`@sqlbraid/sqlite/node-sqlite`, `@sqlbraid/sqlite/wasm`, or
`@sqlbraid/sqlite/d1`. Node requires `node:sqlite` from Node 22.18 or newer.
The Node and WASM adapters preserve INTEGER values as decimal strings, REAL as
numbers, TEXT as strings, and BLOB as `Uint8Array`. D1 cannot guarantee full
SQLite int64 fidelity and does not provide streaming or callback transactions.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
