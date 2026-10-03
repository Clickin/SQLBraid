# PostgreSQL 빠른 시작

> 직접 클라이언트나 명시적인 풀로 SQLBraid를 pg에 연결합니다.

SQLBraid 런타임 파사드와 PostgreSQL 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid pg
```

## 물리 클라이언트에 직접 연결하기

직접 연결 팩토리는 연결된 `pg.Client`나 `pg.PoolClient`를 받습니다. `pg.Pool`은 받지 않습니다.

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

애플리케이션이 `pg.Pool`을 가지고 있다면 풀 팩토리를 쓰세요.

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

풀을 쓰는 루트 작업은 커넥션 리스 하나를 획득하고, 물리 I/O를 실행하고, 리스를 반환한 다음, 메모리로 읽은 결과를 매핑합니다. 커넥션을 고정하는 명시적인 경계는 트랜잭션입니다. 트랜잭션 안에서는 모든 작업에 콜백 핸들을 쓰세요. 풀 종료는 애플리케이션이 맡습니다.

pg 바인딩 어댑터는 논리적인 `RenderedStatement`를 받아 텍스트·위치 기반 `$1`, `$2`, … 플레이스홀더와 순서가 있는 값 배열로 바꿉니다. 이 단계는 드라이버가 맡으며, 순수한 바인딩 설명 이후, 리스 획득 이전에 일어납니다. 플레이스홀더 표기는 PostgreSQL 방언이 정하지 않습니다. 어댑터는 드라이버가 맡는 단순 재사용 방식을 보고하고, 지원하지 않는 파라미터 힌트는 I/O 전에 거부합니다.

:::caution `createPgDatabase`에 풀을 넘기지 마세요
SQLBraid는 모양만 보고 풀을 판별하지 않습니다. 직접 연결 팩토리에 `pg.Pool`을 넘기면 소유권 모델이 틀어집니다. `createPgPoolDatabase(pool)`을 쓰세요.
:::

이 경계에 대한 자세한 내용은 [직접 연결과 풀](/SQLBraid/v/1.0.2/runtime/direct-pools.md), [트랜잭션](/SQLBraid/v/1.0.2/runtime/transactions.md)을 보세요.

## 스트리밍과 루틴

애플리케이션이 `db.stream()`을 쓸 때만 `pg-cursor`를 설치하세요.

```bash
npm install pg-cursor
```

일반 쿼리에는 이 피어 의존성이 필요 없습니다.

- PostgreSQL 스트리밍은 커서로 묶음 단위로 읽습니다. 이 기능이 없으면 `BRAID_STREAM_UNSUPPORTED`를 보고합니다.
- 중단하면 진행 중인 묶음 읽기를 포함해 물리 `Client.end()`가 끝날 때까지 기다린 뒤 커넥션을 폐기합니다.
- 풀은 그 커넥션을 새것으로 바꿉니다. 직접 클라이언트는 직접 교체해야 합니다.
- 중단 가능한 스트림을 쓰려면 직접 만든 래퍼가 `end()`를 제공해야 합니다.

`refcursor` OUT·INOUT 파라미터가 있는 루틴에는 `postgresParameter.refcursor()`를 쓰세요. 루틴은 기존 `db.tx(async (tx) => tx.call(query))` 범위 안에서 호출합니다. SQLBraid는 트랜잭션의 포털을 가져와 닫고, 스칼라 `output`에서 빼고, 그 행을 `resultSets`로 반환합니다. 숨은 트랜잭션은 만들지 않습니다.

## pg 표현 방식 프로필

기본 `pg` 프로필은 `pg-lossless-text`입니다. 드라이버가 텍스트를 줄 수 있으면 JSON과 날짜·시간 값을 텍스트로 유지합니다. `@sqlbraid/postgres`는 `typePolicyForProfile({ json, temporal })`과 변경할 수 없는 `representationProfiles` 설명 객체를 export합니다. 그래서 런타임과 코드 생성이 정확히 같은 정책을 쓸 수 있습니다.

```ts
import { typePolicyForProfile } from "sqlbraid/pg";
import { generateModels } from "@sqlbraid/codegen";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy });
```

`{ json: "native", temporal: "native" }`는 별도의 `pg-native` 호환 프로필을 고릅니다. 여기서 네이티브란 node-postgres의 OID별 기본 파서 동작을 뜻합니다. 모든 날짜·시간 타입이 `Date`가 된다는 뜻은 아닙니다. 직접 만든 `pg-types` 파서는 또 다른 프로필이며, 고유한 원시 값 근거가 필요합니다.

| 값                                   | 드라이버 원시 값 / SQLBraid 정규 출력   | 정확도 경계                                                                                                                       |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `int2` / `int4` / `int8` / `oid`     | 드라이버에 따라 다름 → `string`         | 정확한 출력은 정규 텍스트이며, `number`나 `bigint`가 되지 않습니다.                                                               |
| `numeric` / `decimal`                | 텍스트 → `string`                       | JavaScript `number`는 정확한 값으로 인정하지 않습니다.                                                                            |
| `float4` / `float8`                  | number → `number`                       | 근사 이진 값입니다. 무손실 텍스트 읽기 프로필에서는 `SHOW extra_float_digits`가 양수여야 합니다.                                  |
| `money`                              | 미지원                                  | PostgreSQL의 로캘 형식 텍스트는 정규 숫자 값이 아닙니다. 형식을 명시한 변환을 직접 쓰세요.                                        |
| `json` / `jsonb`                     | 텍스트 → `string`, 네이티브 → `unknown` | 파싱된 최상위 값은 문자열, 숫자, 불리언, `null`, 배열, 객체일 수 있습니다. 네이티브에서는 중첩 숫자의 정확도를 보장하지 않습니다. |
| `date` / `timestamp` / `timestamptz` | 텍스트 → `string`, 네이티브 → `Date`    | 네이티브 모드에서도 `time`/`timetz`는 텍스트로 남고, `interval`은 `unknown`입니다.                                                |
| `bytea`                              | `Buffer`                                | 바이트를 그대로 유지하거나 명시적으로 인코딩하세요.                                                                               |
| `uuid`                               | string                                  | 필요하면 애플리케이션 스키마에서 형식을 검증하세요.                                                                               |

- 문서화된 프로필이 왕복 정확도를 증명하는 경우, 정확한 문자열 입력은 텍스트·위치 기반 바인딩 경로로 지원됩니다.
- 일반 `undefined` 바인딩은 획득 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
- 배열, 도메인, 범위, 다중 범위, 복합 타입은 분류되지 않은 컨테이너입니다. 원소 타입이 정확한 스칼라여도 마찬가지입니다.

`db.environment()`는 선택한 프로필(예: `pg-lossless-text`)과 TypePolicy의 id·해시를 보고합니다. 서버 설정 `extra_float_digits`를 읽지만 값 자체를 보고하지는 않습니다. 값이 0보다 크면 `numeric.approximate-float`는 `guaranteed`이고, 아니면 조건 `pg.extra-float-digits`와 함께 `guarded`입니다. 이 보고를 무조건적인 정확도 보장으로 읽지 마세요. [런타임·드라이버 지원 매트릭스](/SQLBraid/v/1.0.2/reference/support.md)는 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합마다 등급을 기록하고, 해당 리비전과 워크플로 근거를 함께 남깁니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다.

- `pg-cursor`가 네이티브 풀(pull) 스트림을 제공합니다. 피어 의존성이 없으면 `BRAID_STREAM_UNSUPPORTED`가 납니다.
- 루틴 refcursor는 기존 트랜잭션이 필요하며, 메모리로 읽은 결과 집합이 됩니다.
- 벌크는 어댑터가 증명한 네이티브 또는 준비된 문장 방식을 씁니다. SQL을 고쳐 쓰지 않습니다.
- `RETURNING`을 포함한 네이티브 PostgreSQL SQL은 바뀌지 않고 그대로 전달됩니다. SQLBraid가 PostgreSQL 문법을 지원한다는 뜻은 아닙니다.
