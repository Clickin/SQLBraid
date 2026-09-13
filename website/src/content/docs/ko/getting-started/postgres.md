---
title: PostgreSQL 빠른 시작
description: 직접 클라이언트 또는 명시적 풀로 SQLBraid를 pg에 연결합니다.
---

SQLBraid PostgreSQL 어댑터와 드라이버를 함께 설치하세요.

```bash
npm install @sqlbraid/postgres pg
```

## 직접 물리 클라이언트

직접 팩토리는 연결된 `pg.Client` 또는 `pg.PoolClient`를 받으며 `pg.Pool`은 받지 않습니다.

```ts
import { Client } from "pg";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

interface UserRow { id: number; name: string }

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const db = createPgDatabase(client);

try {
  const users = await db.all<UserRow>(sql.rows<UserRow>`
    SELECT id, name FROM users ORDER BY id
  `);
  console.log(users);
} finally {
  await client.end();
}
```

## 풀 기반 데이터베이스

애플리케이션이 `pg.Pool`을 소유한다면 풀 팩토리를 사용하세요.

```ts
import { Pool } from "pg";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);
const accountId = 1;

try {
  const account = await db.one(sql.rows<{ id: number; email: string }>`
    SELECT id, email FROM accounts WHERE id = ${accountId}
  `);
  console.log(account);
} finally {
  await pool.end();
}
```

풀 기반 루트 작업은 연결 lease 하나를 얻어 물리적 I/O를 수행하고 lease를 반환한 다음 구체화된 결과를 매핑합니다. 트랜잭션은 명시적으로 연결을 고정하는 경계이므로, 트랜잭션 내부의 모든 작업에는 콜백 핸들을 사용하세요. 풀 종료는 애플리케이션이 소유합니다.

:::caution `createPgDatabase`에 풀을 전달하지 마세요
SQLBraid는 duck typing으로 풀을 판별하지 않습니다. 직접 팩토리에 `pg.Pool`을 전달하는 것은 잘못된 소유 모델이므로 `createPgPoolDatabase(pool)`을 사용하세요.
:::

자세한 경계는 [직접 연결과 풀](/SQLBraid/runtime/direct-pools/) 및 [트랜잭션](/SQLBraid/runtime/transactions/)을 참고하세요.
