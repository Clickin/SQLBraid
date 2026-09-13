# @sqlbraid/mysql

MySQL SQL dialect, mysql2 database adapters, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

```ts
import { sql } from "@sqlbraid/mysql";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
const query = sql`SELECT * FROM users WHERE id = ${1}`;
```

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for connection and inspection setup.
