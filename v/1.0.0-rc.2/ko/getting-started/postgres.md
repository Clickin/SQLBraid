# PostgreSQL 빠른 시작

> 직접 클라이언트 또는 명시적 풀로 SQLBraid를 pg에 연결합니다.

SQLBraid PostgreSQL 어댑터와 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid pg
```

## 직접 물리 클라이언트

직접 팩토리는 연결된 `pg.Client` 또는 `pg.PoolClient`를 받으며 `pg.Pool`은 받지 않습니다.

```ts
import { Client } from "pg";
import { createPgDatabase, sql } from "sqlbraid/pg";

interface UserRow { id: string; name: string }

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

풀 기반 루트 작업은 연결 lease 하나를 얻어 물리적 I/O를 수행하고 lease를 반환한 다음 구체화된 결과를 매핑합니다. 트랜잭션은 명시적으로 연결을 고정하는 경계이므로, 트랜잭션 내부의 모든 작업에는 콜백 핸들을 사용하세요. 풀 종료는 애플리케이션이 소유합니다.

pg 바인딩 어댑터는 논리 `RenderedStatement`를 받은 뒤 text-positional
`$1`, `$2`, … placeholder와 순서가 있는 값 배열을 구체화합니다. 이 드라이버
단계는 순수한 바인딩 설명 후, lease를 얻기 전에 수행되며 placeholder 표기는
PostgreSQL dialect가 제공하지 않습니다. 어댑터는 드라이버 소유 simple reuse를
보고하고 지원하지 않는 파라미터 힌트는 I/O 전에 거부합니다.

:::caution `createPgDatabase`에 풀을 전달하지 마세요
SQLBraid는 duck typing으로 풀을 판별하지 않습니다. 직접 팩토리에 `pg.Pool`을 전달하는 것은 잘못된 소유 모델이므로 `createPgPoolDatabase(pool)`을 사용하세요.
:::

자세한 경계는 [직접 연결과 풀](/SQLBraid/v/1.0.0-rc.2/runtime/direct-pools.md) 및 [트랜잭션](/SQLBraid/v/1.0.0-rc.2/runtime/transactions.md)을 참고하세요.

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

기본 `pg` 프로필은 `pg-lossless-text`이며 driver가 제공할 수 있는
JSON과 temporal 값을 text로 유지합니다. `@sqlbraid/postgres`는
`typePolicyForProfile({ json, temporal })`와 immutable
`representationProfiles` descriptor를 내보내므로 runtime과 codegen이 같은
정책을 재사용할 수 있습니다.

```ts
import { typePolicyForProfile } from "sqlbraid/pg";
import { generateModels } from "@sqlbraid/codegen";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy });
```

`{ json: "native", temporal: "native" }`는 별도
`pg-native` 호환 프로필을 선택합니다. native는 node-postgres의 일반
OID별 parser 동작을 뜻하며 모든 temporal 타입이 `Date`가 된다는 뜻이
아닙니다. custom `pg-types` parser는 또 다른 프로필이므로 자체 raw-value
증거가 필요합니다.

| 값 | Driver raw / SQLBraid canonical 출력 | 정확도 경계 |
| --- | --- | --- |
| `int2` / `int4` / `int8` / `oid` | driver 의존 → `string` | exact 출력은 `number`나 `bigint`가 아닌 canonical text입니다. |
| `numeric` / `decimal` | text → `string` | JavaScript `number`는 exact로 허용하지 않습니다. |
| `float4` / `float8` | number → `number` | 근사 이진 값이며 lossless text read에는 `SHOW extra_float_digits` 양수가 필요합니다. |
| `money` | unsupported | locale 형식 text는 표준 숫자값이 아니므로 사용자가 명시적 format 변환을 작성해야 합니다. |
| `json` / `jsonb` | text → `string`; native → `unknown` | Parsed root는 string, number, boolean, `null`, array, object일 수 있어 중첩 숫자 정확도를 보장하지 않습니다. |
| `date` / `timestamp` / `timestamptz` | text → `string`; native → `Date` | native `time`/`timetz`는 text이며 `interval`은 `unknown`입니다. |
| `bytea` | `Buffer` | byte로 유지하거나 명시적으로 encode합니다. |
| `uuid` | string | 필요하면 애플리케이션 schema에서 형식을 검증합니다. |

문서화된 프로필에서 end-to-end 왕복이 증명된 경우 text-positional bind로
정확한 문자열 입력을 지원합니다. 일반 `undefined` bind는 connection을
얻기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패하며 `null`은 SQL `NULL`입니다.
배열, domain, range/multirange, composite는 scalar 원소 타입이 exact여도
unclassified container입니다.

`db.environment()`는 `extra_float_digits`, 선택한 JSON/temporal 프로필과
가능한 경우 TypePolicy provenance를 기록합니다. 이를 무조건적인 fidelity
보장으로 읽으면 안 됩니다. 지원 label과 증거는 [런타임/드라이버 지원
매트릭스](/SQLBraid/v/1.0.0-rc.2/reference/support.md)가 기록한 정확한 database, driver,
profile, runtime, capability tuple과 revision별 실행 workflow에만 적용됩니다.
인접한 버전·runtime·profile 또는 package 설치는 이 프로필을 인증하지
않습니다. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release
승인은 별도 요구사항입니다.
`pg-cursor`는 native pull stream을 제공하며 peer가 없으면
`BRAID_STREAM_UNSUPPORTED`입니다. Routine refcursor는 기존 transaction이
필요하고 result set으로 materialize됩니다. Bulk는 SQL rewrite가 아닌
검증된 adapter native 또는 prepared 전략을 사용합니다. `RETURNING`을
포함한 native PostgreSQL SQL은 투명하게 전달되지만, 이것은 SQLBraid의
PostgreSQL grammar 지원을 의미하지 않습니다.
