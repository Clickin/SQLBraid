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

pg 바인딩 어댑터는 논리 `RenderedStatement`를 받은 뒤 text-positional
`$1`, `$2`, … placeholder와 순서가 있는 값 배열을 구체화합니다. 이 드라이버
단계는 순수한 바인딩 설명 후, lease를 얻기 전에 수행되며 placeholder 표기는
PostgreSQL dialect가 제공하지 않습니다. 어댑터는 드라이버 소유 simple reuse를
보고하고 지원하지 않는 파라미터 힌트는 I/O 전에 거부합니다.

:::caution `createPgDatabase`에 풀을 전달하지 마세요
SQLBraid는 duck typing으로 풀을 판별하지 않습니다. 직접 팩토리에 `pg.Pool`을 전달하는 것은 잘못된 소유 모델이므로 `createPgPoolDatabase(pool)`을 사용하세요.
:::

자세한 경계는 [직접 연결과 풀](/SQLBraid/runtime/direct-pools/) 및 [트랜잭션](/SQLBraid/runtime/transactions/)을 참고하세요.

## 스트리밍과 루틴

이 애플리케이션에서 `db.stream()`을 사용할 때만 `pg-cursor`를 설치하세요.

```bash
npm install pg-cursor
```

일반 쿼리에는 optional peer가 필요하지 않습니다. PostgreSQL 스트리밍은
cursor batch read를 사용하며 capability가 없으면
`BRAID_STREAM_UNSUPPORTED`를 보고합니다. Abort는 대기 중 batch read도
중단하도록 물리적 `Client.end()` 완료 후 연결을 폐기합니다. Pool은 새 연결을
제공하며 direct client는 교체해야 합니다. Abort 가능한 custom wrapper에는
`end()`가 필요합니다. `refcursor` OUT/INOUT 루틴은
`postgresParameter.refcursor()`로 표시하고 기존
`db.tx(async (tx) => tx.call(query))` 범위 안에서 호출하세요. SQLBraid는
transaction-bound portal을 fetch/close하고 scalar `output`에서 제거한 뒤
행을 `resultSets`로 반환하며 숨은 transaction을 만들지 않습니다.

## pg 표현 프로필

이 프로필은 support manifest가 기록한 정확한 database/runtime 조합에서
`pg` 기본 parser를 사용합니다. custom `pg-types` parser는 별도의
conditional 프로필이며 자체 raw-value 증거가 필요합니다.

| 값 | 기본 프로필 표현 | 경계 |
| --- | --- | --- |
| `int8` | string | 애플리케이션에서 `bigint`가 필요하면 `decodeExactInteger`를 사용합니다. |
| `numeric`/`decimal` | string | 텍스트를 유지하거나 애플리케이션 10진 라이브러리를 사용하며 `number`로 변환하지 않습니다. |
| `json`/`jsonb` | 파싱된 JavaScript 값 | Standard Schema로 검증합니다. custom parser는 텍스트를 반환할 수도 있습니다. |
| `bytea` | `Buffer` | byte로 유지하거나 명시적으로 encode합니다. |
| `uuid` | string | 필요하면 애플리케이션 schema에서 형식을 검증합니다. |
| 날짜/시간 | 설정한 variant에 따라 JavaScript `Date` 또는 driver text | `Date`는 모든 원본 offset/precision을 보존하지 않습니다. |

바인드 전송은 순서가 있는 값과 text-positional `$1`, `$2`, …입니다.
`pg-cursor`가 native pull stream을 제공하며 peer가 없으면
`BRAID_STREAM_UNSUPPORTED`입니다. Routine refcursor는 기존 transaction이
필요하고 result set으로 materialize됩니다. Bulk는 SQL rewrite가 아닌
검증된 adapter native 또는 prepared 전략을 사용합니다. `RETURNING`을
포함한 native PostgreSQL SQL은 투명하게 전달되지만, 이것은 SQLBraid의
PostgreSQL grammar 지원을 의미하지 않습니다.
