---
title: MySQL 빠른 시작
description: 직접 연결 또는 명시적 풀로 SQLBraid를 mysql2에 연결합니다.
---

SQLBraid MySQL 어댑터와 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid mysql2
```

## 직접 물리 연결

직접 팩토리는 `mysql2/promise`의 연결된 `Connection`이나 `PoolConnection` 객체를 받습니다. 해결되지 않은 Promise나 풀은 받지 않습니다.

```ts
import mysql from "mysql2/promise";
import { createMysql2Database, MYSQL2_LOSSLESS_TEXT, sql } from "sqlbraid/mysql2";

const connection = await mysql.createConnection({
  uri: process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
});
const db = createMysql2Database(connection, { profile: MYSQL2_LOSSLESS_TEXT });

try {
  const rows = await db.all(sql.rows<{ id: string; name: string }>`
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
import { createMysql2PoolDatabase, MYSQL2_LOSSLESS_TEXT, sql } from "sqlbraid/mysql2";

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
});
const db = createMysql2PoolDatabase(pool, { profile: MYSQL2_LOSSLESS_TEXT });
const userId = 1;
try {
  const user = await db.maybeOne(sql.rows<{ id: string; name: string }>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(user);
} finally {
  await pool.end();
}
```

풀은 애플리케이션의 리소스로 남습니다. SQLBraid는 독립적인 루트 작업마다 물리적 연결을 얻고 반환합니다. `db.tx(...)`는 콜백 동안 lease 하나를 고정합니다. 풀 종료는 애플리케이션이 소유합니다.

프로필이나 정책을 선택하지 않으면 각 lease는 관측한 연결에서 정책을 얻습니다.
풀은 연결 획득 전에 정책을 단정하지 않습니다. 명시한 descriptor가 기준으로
남습니다. 호환되지 않는 native 결과는 실패합니다. SQLBraid는 runtime 규칙을
codegen과 다르게 조용히 바꾸지 않습니다.

mysql2 바인딩 어댑터는 논리 문장을 text-positional `?` placeholder와 순서가
있는 값 배열로 구체화합니다. 바인딩 설명과 힌트 검증은 연결 획득 전에
수행됩니다. `reuse` 요청을 포함한 유효 reuse는 mysql2가 소유합니다. 지원하지
않는 힌트는 드라이버 I/O 전에 실패합니다.

:::caution `createMysql2Database`에 풀을 전달하지 마세요

풀에는 `createMysql2PoolDatabase(pool)`을 사용하세요. 명시적 팩토리는 트랜잭션과 반환 의미를 물리적 연결에 안전하게 유지합니다.

## 스트리밍과 루틴 경계

`db.stream()`은 promise connection 뒤의 raw prepared `Execute.stream()`
command를 사용합니다. prepared/binary 실행을 유지합니다. text `query()`로
바꾸지 않습니다. break나 abort가 발생하면 SQLBraid는 행 전달을 멈춥니다. 그
다음 연결 반환 전에 command를 drain하거나 물리 연결을 폐기합니다.

MySQL emitted result set은 서로 다른 형태일 수 있습니다.

```ts
const result = await db.call(
  sql.call({
    resultSets: [UserSchema, SummarySchema] as const,
  })`CALL dashboard()`,
);
```

Prepared CALL OUT/INOUT은 현재 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다.
mysql2 3.x에는 protocol의 추가 OUT carrier result를 구분하는 검증된 public
discriminator가 없습니다. 따라서 SQLBraid는 carrier 행을 추측하지 않습니다.
Stored function은 result set을 내보낼 수 없습니다.

## mysql2 표현 프로필

이것은 명시적 설정 프로필입니다. 암묵적인 가정이 아닙니다.

- `@sqlbraid/mysql`은 `typePolicyForProfile({ json, temporal })`와 immutable
  `representationProfiles`를 내보냅니다.
- 기본 `mysql2-lossless-text` descriptor는 아래 fidelity-first option을
  사용합니다.
- `mysql2-native`는 native JSON/temporal 결과를 쓰는 별도의 편의 프로필입니다.
- runtime과 codegen은 같은 descriptor를 선택해야 합니다.

[런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)는 정확한
database, driver, profile, runtime, capability tuple별 label을 그 revision 및
workflow 증거와 함께 기록합니다. 인접한 버전이나 package 설치는 인증이
아닙니다. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release 승인은
별도 요구사항입니다.

| mysql2 옵션              | `mysql2-lossless-text` | 효과                                                                               |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `bigNumberStrings: true` | 필수                   | 큰 숫자를 문자열로 반환해 애플리케이션이 정확하게 처리합니다.                      |
| `decimalNumbers: false`  | 필수                   | `DECIMAL`을 JavaScript `number`로 변환하지 않습니다. `true`는 별도 프로필입니다.   |
| `rowsAsArray: false`     | 필수                   | SQLBraid normalizer와 schema가 기대하는 객체 행을 유지합니다.                      |
| `jsonStrings: true`      | 필수                   | `JSON.parse` 없이 JSON text를 반환하며 parsed JSON은 별도 프로필입니다.            |
| `dateStrings: true`      | 필수                   | fractional precision이 보이는 temporal text를 반환하며 `Date`는 별도 프로필입니다. |
| `typeCast` (기본값)      | 필수                   | custom 함수는 raw 표현을 바꾸므로 테스트 전까지 별도 프로필입니다.                 |

유효 프로필에는 mysql2 버전, MySQL server, Node 버전, 위 option 전체를
기록합니다. SQLBraid는 custom `typeCast` 함수를 검사하거나 그 출력을 추론하지
않습니다. Driver raw 값과 SQLBraid canonical 값은 별개의 사실입니다.

- exact 프로필에서 정수와 `DECIMAL` 결과는 canonical string입니다.
  애플리케이션 경계에서 `decodeExactInteger`, `decodeExactDecimal`, 선택한
  숫자 transform을 사용하세요.
- `FLOAT`와 `DOUBLE`은 JavaScript `number` (binary32/binary64)로 남습니다.
- driver가 제공하는 `insertId`는 exact string입니다.
- `affectedRows`는 safe-range 검사를 하는 운영 count입니다.
- Native MySQL SQL은 변경 없이 전달됩니다. 이것은 SQLBraid가 모든 MySQL
  grammar를 파싱한다는 뜻이 아닙니다.

정확한 정수/10진수 string은 prepared 및 bulk 실행에서 왕복 정확도를 위한
문서화된 bind 경로입니다. 일반 `undefined` bind는 acquisition 전에
`BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
`decimalNumbers`, `jsonStrings`, `dateStrings`, `typeCast`를 바꾸면 다른
프로필을 선택하는 것입니다. 다시 테스트하기 전까지 위 증거는 유효하지 않습니다.

- 바인드 전송은 mysql2 text-positional `?`와 순서가 있는 값입니다.
- 스트리밍은 prepared `Execute.stream()`을 사용합니다.
- `db.call()`이 routine result set을 materialize합니다. prepared OUT/INOUT은
  지원하지 않습니다.
- Bulk는 선택한 adapter의 capability와 manifest가 증명할 때만 prepared/native
  driver 연산입니다.
- 일반 MySQL DML에는 portable `RETURNING` 절이 없습니다. 따라서 SQLBraid는 반환
  행을 만들어내지 않습니다.
