# Interactive browser preview

> Edit and run real SQL against a disposable SQLite WASM database in your browser.

The preview below uses the same SQLBraid SQLite WASM adapter that an application
bundle can use. Write or paste a SQL statement, then run it against an official
SQLite WASM `:memory:` database in a Web Worker. The fixture is deterministic
finance data with Korean and other Unicode account names.

Try:

- `SELECT` statements, including your own filters and joins;
- `INSERT`, `UPDATE`, and other single-statement commands against the disposable database;
- readable SQLite syntax/runtime errors, followed by a corrected query;
- **Inspect schema** to see the seeded table definition; and
- **Reset seeded database** to restore the original rows after a mutation.

The result table shows at most the first 1,000 rows so exploratory queries stay
responsive. A worker that runs longer than ten seconds is replaced and its
database is reset.

The SQL is intentionally user-authored raw text inside this disposable database:
the preview does not interpolate it into a server query, claim injection safety,
or persist any changes.

The rendered [interactive preview](https://clickin.github.io/SQLBraid/v/1.0.0/interactive-preview/) is available on the documentation site.

The default path deliberately does not require OPFS, persistence,
`SharedArrayBuffer`, or COOP/COEP headers. A production application can choose
another SQLite WASM storage mode separately; this documentation preview stays
portable on static hosting such as GitHub Pages.
