---
title: PostgreSQL 빠른 시작
description: 직접 클라이언트 또는 명시적 풀로 SQLBraid를 pg에 연결합니다.
---

SQLBraid PostgreSQL 어댑터와 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid pg
```

## 직접 물리 클라이언트

직접 팩토리는 연결된 `pg.Client`나 `pg.PoolClient`를 받습니다. `pg.Pool`은 받지 않습니다.

```ts
import { Client } from "pg";
import { createPgDatabase, sql } from "sqlbraid/pg";

interface UserRow {
  id: string;
  name: string;
}

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
import { createPgPoolDatabase, sql } from "sqlbraid/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);
const accountId = 1;

try {
  const account = await db.one(sql.rows<{ id: string; email: string }>`
    SELECT id, email FROM accounts WHERE id = ${accountId}
  `);
  console.log(account);
} finally {
  await pool.end();
}
```

풀 기반 루트 작업은 다음 순서로 동작합니다: 연결 lease 하나를 얻고, 물리적 I/O를 수행하고, lease를 반환한 다음, 구체화된 결과를 매핑합니다. 트랜잭션은 연결을 고정하는 명시적 경계입니다. 트랜잭션 안에서는 모든 작업에 콜백 핸들을 사용하세요. 풀 종료는 애플리케이션이 소유합니다.

pg 바인딩 어댑터는 논리 `RenderedStatement`를 받습니다. 그 다음
text-positional `$1`, `$2`, … placeholder와 순서가 있는 값 배열을
구체화합니다. 이 단계는 드라이버가 소유합니다. 순수한 바인딩 설명 후, lease
획득 전에 수행됩니다. placeholder 표기는 PostgreSQL dialect가 제공하지
않습니다. 어댑터는 드라이버가 소유하는 simple reuse를 보고합니다. 지원하지
않는 파라미터 힌트는 I/O 전에 거부합니다.

:::caution `createPgDatabase`에 풀을 전달하지 마세요

SQLBraid는 duck typing으로 풀을 판별하지 않습니다. 직접 팩토리에 `pg.Pool`을 전달하면 소유 모델이 잘못됩니다. `createPgPoolDatabase(pool)`을 사용하세요.

자세한 경계는 [직접 연결과 풀](/SQLBraid/runtime/direct-pools/) 및 [트랜잭션](/SQLBraid/runtime/transactions/)을 참고하세요.

## 스트리밍과 루틴

이 애플리케이션에서 `db.stream()`을 사용할 때만 `pg-cursor`를 설치하세요.

```bash
npm install pg-cursor
```

일반 쿼리에는 이 peer가 필요하지 않습니다.

- PostgreSQL 스트리밍은 cursor batch read를 사용합니다. capability가 없으면
  `BRAID_STREAM_UNSUPPORTED`를 보고합니다.
- Abort는 물리적 `Client.end()` 완료를 기다린 뒤 연결을 폐기합니다. 대기 중인
  batch read도 포함됩니다.
- Pool은 그 연결을 교체합니다. direct client는 직접 교체해야 합니다.
- Abort 가능한 stream을 위해 custom wrapper는 `end()`를 노출해야 합니다.

`refcursor` OUT/INOUT 파라미터가 있는 루틴에는 `postgresParameter.refcursor()`를
사용하세요. 루틴은 기존 `db.tx(async (tx) => tx.call(query))` 범위 안에서
호출하세요. SQLBraid는 transaction의 portal을 fetch하고 닫습니다. portal을
scalar `output`에서 제거하고 행을 `resultSets`로 반환합니다. 숨은 transaction을
만들지 않습니다.

## pg 표현 프로필

기본 `pg` 프로필은 `pg-lossless-text`입니다. driver가 text를 제공할 수 있으면
JSON과 temporal 값은 text로 남습니다. `@sqlbraid/postgres`는
`typePolicyForProfile({ json, temporal })`와 immutable
`representationProfiles` descriptor를 내보냅니다. 따라서 runtime과 codegen이
같은 정책을 사용할 수 있습니다.

```ts
import { typePolicyForProfile } from "sqlbraid/pg";
import { generateModels } from "@sqlbraid/codegen";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy });
```

`{ json: "native", temporal: "native" }`는 별도의 `pg-native` 호환 프로필을
선택합니다. native는 node-postgres의 일반 OID별 parser 동작을 뜻합니다. 모든
temporal 타입이 `Date`가 된다는 뜻이 아닙니다. custom `pg-types` parser는 또
다른 프로필입니다. 자체 raw-value 증거가 필요합니다.

| 값                                   | Driver raw / SQLBraid canonical 출력 | 정확도 경계                                                                                                  |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `int2` / `int4` / `int8` / `oid`     | driver 의존 → `string`               | exact 출력은 `number`나 `bigint`가 아닌 canonical text입니다.                                                |
| `numeric` / `decimal`                | text → `string`                      | JavaScript `number`는 exact로 허용하지 않습니다.                                                             |
| `float4` / `float8`                  | number → `number`                    | 근사 이진 값이며 lossless text read에는 `SHOW extra_float_digits` 양수가 필요합니다.                         |
| `money`                              | unsupported                          | locale 형식 text는 표준 숫자값이 아니므로 사용자가 명시적 format 변환을 작성해야 합니다.                     |
| `json` / `jsonb`                     | text → `string`; native → `unknown`  | Parsed root는 string, number, boolean, `null`, array, object일 수 있어 중첩 숫자 정확도를 보장하지 않습니다. |
| `date` / `timestamp` / `timestamptz` | text → `string`; native → `Date`     | native `time`/`timetz`는 text이며 `interval`은 `unknown`입니다.                                              |
| `bytea`                              | `Buffer`                             | byte로 유지하거나 명시적으로 encode합니다.                                                                   |
| `uuid`                               | string                               | 필요하면 애플리케이션 schema에서 형식을 검증합니다.                                                          |

- 문서화된 프로필이 전체 왕복을 증명하면 text-positional bind로 정확한 문자열
  입력을 지원합니다.
- 일반 `undefined` bind는 connection 획득 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로
  실패합니다. `null`은 SQL `NULL`입니다.
- 배열, domain, range/multirange, composite는 unclassified container입니다.
  scalar 원소 타입이 exact여도 마찬가지입니다.

`db.environment()`는 선택한 프로필(예: `pg-lossless-text`)과 TypePolicy의
id와 hash를 보고합니다. 서버 설정 `extra_float_digits`를 읽지만 그 값을
보고하지는 않습니다. 값이 0보다 크면 `numeric.approximate-float`는
`guaranteed`입니다. 그렇지 않으면 `pg.extra-float-digits` 조건과 함께
`guarded`입니다. 이 보고를 무조건적인 fidelity 보장으로 읽지 마세요. [런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)는
정확한 database, driver, profile, runtime, capability tuple별 label을 그
revision 및 workflow 증거와 함께 기록합니다. 인접한 버전이나 package 설치는
인증이 아닙니다. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release
승인은 별도 요구사항입니다.

- `pg-cursor`는 native pull stream을 제공합니다. peer가 없으면
  `BRAID_STREAM_UNSUPPORTED`입니다.
- Routine refcursor에는 기존 transaction이 필요합니다. result set으로
  materialize됩니다.
- Bulk는 검증된 adapter native 또는 prepared 전략을 사용합니다. SQL을
  rewrite하지 않습니다.
- `RETURNING`을 포함한 native PostgreSQL SQL은 변경 없이 전달됩니다. 이것은
  SQLBraid가 PostgreSQL grammar를 지원한다는 뜻이 아닙니다.
