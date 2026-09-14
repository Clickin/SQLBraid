---
title: MariaDB 빠른 시작
description: MariaDB Connector/Node.js에서 MariaDB SQL 문법을 명시적으로 유지합니다.
---

별도 MariaDB dialect와 공식 Connector/Node.js 드라이버를 설치하세요.

```bash
npm install @sqlbraid/mariadb mariadb
```

`/mariadb` 어댑터 subpath를 연결된 connection 또는 명시적 pool factory와
함께 사용합니다.

```ts
import mariadb from "mariadb";
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
});
const db = createMariaDbDatabase(connection);
const users = await db.all(sql.rows<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE id = ${1}
`);
```

Dialect는 `mysql`이 아닌 `mariadb`입니다. MariaDB 전용 문법은 SQL로
그대로 작성합니다. 현재 capability fixture는 문서화된
`INSERT ... RETURNING`, `DELETE ... RETURNING`, `REPLACE ... RETURNING`,
sequence, CTE, JSON function을 다룹니다. `UPDATE ... RETURNING`은 주장하지
않으며, `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING`은 실제 서버 증거가
있을 때만 지원 목록에 올립니다.

어댑터는 Connector/Node.js value-only 실행, native row stream, 그리고
`db.bulk()`의 `connection.batch()` 1회를 사용합니다. Root bulk는 암묵적으로
transaction이 되지 않고 portable auto-chunking 약속이 없습니다. 원자성이
필요하면 `db.tx()`를 사용하세요.

MariaDB에서 `mysql2` connection이 동작할 수 있지만 best-effort 호환일 뿐
Official MariaDB 문법/protocol 증거가 아닙니다. PV16 정확한 최종 SHA 검증은
아직 pending입니다.
