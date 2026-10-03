# Interactive browser preview

> Edit and run real SQL on a disposable SQLite WASM database in your browser.

The preview below uses the same SQLBraid SQLite WASM adapter that an application
bundle can use. Write or paste a SQL statement. Then run it on an official
SQLite WASM `:memory:` database in a Web Worker. The fixture is deterministic
finance data. Some account names are Korean or use other Unicode characters.

Try these things:

- `SELECT` statements, with your own filters and joins;
- `INSERT`, `UPDATE` and other single-statement commands on the disposable database;
- a SQLite syntax or runtime error, then a corrected query;
- **Inspect schema**, to see the table definition of the seed data;
- **Reset seeded database**, to restore the original rows after a change.

The result table shows only the first 1,000 rows. This keeps exploratory queries
responsive. If a worker runs for more than ten seconds, the preview replaces it
and resets its database.

The SQL is raw text that you write, inside this disposable database. This is
intentional. The preview does not interpolate it into a server query. It does not
claim injection safety. It does not keep any changes.

The rendered [interactive preview](https://clickin.github.io/SQLBraid/v/1.0.2/interactive-preview/) is available on the documentation site.

The default path does not require OPFS, persistence, `SharedArrayBuffer` or
COOP/COEP headers. This is intentional. A production application can select a
different SQLite WASM storage mode separately. This documentation preview stays
portable on static hosting such as GitHub Pages.
