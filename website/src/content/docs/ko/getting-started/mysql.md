---
title: MySQL 빠른 시작
description: 직접 연결 또는 명시적 풀로 SQLBraid를 mysql2에 연결합니다.
---

SQLBraid MySQL 어댑터와 드라이버를 함께 설치하세요.

```bash
npm install @sqlbraid/mysql mysql2
```

## 직접 물리 연결

직접 팩토리는 `mysql2/promise`의 연결된 `Connection` 또는 `PoolConnection` 객체를 받습니다. 아직 해결되지 않은 Promise나 풀은 받지 않습니다.

```ts
import mysql from "mysql2/promise";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

const connection = await mysql.createConnection(
  process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
);
const db = createMysql2Database(connection);

try {
  const rows = await db.all(sql.rows<{ id: number; name: string }>`
    SELECT id, name FROM users ORDER BY id
  `);
  console.log(rows);
} finally {
  await connection.end();
}
```

## 풀 기반 데이터베이스

`mysql2/promise` 풀에는 풀 팩토리를 사용하세요.

```ts
import mysql from "mysql2/promise";
import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

const pool = mysql.createPool(process.env.DATABASE_URL ?? "mysql://root:password@localhost/app");
const db = createMysql2PoolDatabase(pool);
const userId = 1;
try {
  const user = await db.maybeOne(sql.rows<{ id: number; name: string }>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(user);
} finally {
  await pool.end();
}
```

풀은 애플리케이션의 리소스로 남습니다. SQLBraid는 독립적인 각 루트 작업마다 물리적 연결을 얻고 반환하며, `db.tx(...)`는 콜백 동안 하나의 lease를 고정합니다. 풀 종료는 애플리케이션이 소유합니다.

mysql2 바인딩 어댑터는 논리 문장을 text-positional `?` placeholder와 순서가
있는 값 배열로 구체화합니다. 바인딩 설명과 힌트 검증은 연결을 얻기 전에
수행되며, `reuse` 요청을 포함한 유효 reuse는 mysql2가 소유합니다. 지원하지
않는 힌트는 드라이버 I/O 전에 실패합니다.

:::caution `createMysql2Database`에 풀을 전달하지 마세요
풀에는 `createMysql2PoolDatabase(pool)`을 사용하세요. 명시적 팩토리는 트랜잭션과 반환 의미가 물리적 연결에 안전하도록 보장합니다.
:::

## 스트리밍과 루틴 경계

`db.stream()`은 promise connection 뒤의 raw prepared
`Execute.stream()` command를 사용합니다. prepared/binary 실행을 유지하며
text `query()`로 낮추지 않습니다. break 또는 abort 시 SQLBraid는 행 전달을
중지하고 lease 반환 전에 command를 drain하거나 물리 연결을 폐기합니다.

MySQL emitted result set은 서로 다른 형태일 수 있습니다.

```ts
const result = await db.call(sql.call({
  resultSets: [UserSchema, SummarySchema] as const,
})`CALL dashboard()`);
```

Prepared CALL OUT/INOUT은 현재 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다.
mysql2 3.x에는 protocol의 추가 OUT carrier result를 구분하는 검증된 public
discriminator가 없으므로 SQLBraid는 carrier 행을 추측하지 않습니다. Stored
function은 result set을 내보낼 수 없습니다.
