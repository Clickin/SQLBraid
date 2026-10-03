# MySQL 빠른 시작

> 직접 연결이나 명시적인 풀로 SQLBraid를 mysql2에 연결합니다.

SQLBraid 런타임 파사드와 MySQL 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid mysql2
```

## 물리 커넥션에 직접 연결하기

직접 연결 팩토리는 `mysql2/promise`의 연결된 `Connection`이나 `PoolConnection` 객체를 받습니다. 아직 resolve되지 않은 Promise나 풀은 받지 않습니다.

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

`mysql2/promise` 풀에는 풀 팩토리를 쓰세요.

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

풀은 계속 애플리케이션의 리소스입니다. SQLBraid는 독립된 루트 작업마다 물리 커넥션을 획득하고 반환합니다. `db.tx(...)`는 콜백 동안 리스 하나를 고정합니다.

프로필이나 정책을 고르지 않으면 리스마다 관찰한 커넥션에서 정책을 가져옵니다. 풀은 획득 전에 정책을 주장하지 않습니다. 명시적인 설명 객체를 주면 그것이 기준이 됩니다. 호환되지 않는 네이티브 결과는 실패합니다. SQLBraid가 런타임 규칙을 코드 생성과 다르게 몰래 바꾸지 않습니다.

mysql2 바인딩 어댑터는 논리 문장을 텍스트·위치 기반 `?` 플레이스홀더와 순서가 있는 값 배열로 바꿉니다. 바인딩 설명과 힌트 검증은 획득 전에 일어납니다. 요청한 `reuse` 정책을 포함해 실제 재사용은 mysql2가 맡습니다. 지원하지 않는 힌트는 드라이버 I/O 전에 실패합니다.

:::caution `createMysql2Database`에 풀을 넘기지 마세요
풀에는 `createMysql2PoolDatabase(pool)`을 쓰세요. 팩토리를 구분해야 물리 커넥션의 트랜잭션·반환 동작이 안전하게 유지됩니다.
:::

## 스트리밍과 루틴의 경계

`db.stream()`은 promise 커넥션 뒤에 있는 원시 준비된 문장 `Execute.stream()` 명령을 씁니다. 준비된 문장의 바이너리 실행을 유지하며, 텍스트 `query()`로 바꾸지 않습니다. 반복을 중간에 멈추거나 중단하면 SQLBraid는 행 전달을 멈춥니다. 그런 다음 커넥션을 반환하기 전에 명령을 끝까지 비우거나 물리 커넥션을 폐기합니다.

MySQL이 출력하는 결과 집합은 서로 형태가 다를 수 있습니다.

```ts
const result = await db.call(
  sql.call({
    resultSets: [UserSchema, SummarySchema] as const,
  })`CALL dashboard()`,
);
```

준비된 문장으로 실행한 CALL의 OUT·INOUT은 현재 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. mysql2 3.x에는 프로토콜의 추가 OUT 전달 결과를 구분하는 검증된 공개 수단이 없습니다. 그래서 SQLBraid는 전달 행을 추측하지 않습니다. 저장 함수는 결과 집합을 출력할 수 없습니다.

## mysql2 표현 방식 프로필

이것은 명시적인 설정 프로필입니다. 암묵적인 가정이 아닙니다.

- `@sqlbraid/mysql`은 `typePolicyForProfile({ json, temporal })`과 변경할 수 없는 `representationProfiles`를 export합니다.
- 기본 `mysql2-lossless-text` 설명 객체는 아래의 정확도 우선 옵션을 씁니다.
- `mysql2-native`는 네이티브 JSON과 날짜·시간 결과를 쓰는 별도의 편의 프로필입니다.
- 런타임과 코드 생성은 같은 설명 객체를 골라야 합니다.

[런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)는 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합마다 등급을 기록하고, 해당 리비전과 워크플로 근거를 함께 남깁니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다.

| mysql2 옵션               | `mysql2-lossless-text` | 효과                                                                                   |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `supportBigNumbers: true` | 필수                   | 큰 정수·소수 값이 손실이 있는 `number` 추론으로 가지 않게 합니다.                      |
| `bigNumberStrings: true`  | 필수                   | 큰 숫자를 문자열로 반환해 애플리케이션이 정확하게 다룰 수 있게 합니다.                 |
| `decimalNumbers: false`   | 필수                   | `DECIMAL`을 JavaScript `number`로 바꾸지 않습니다. `true`는 다른 프로필입니다.         |
| `rowsAsArray: false`      | 필수                   | SQLBraid 정규화기와 스키마가 기대하는 객체 행을 유지합니다.                            |
| `jsonStrings: true`       | 필수                   | `JSON.parse` 없이 JSON 텍스트를 반환합니다. 파싱된 JSON은 별도의 프로필입니다.         |
| `dateStrings: true`       | 필수                   | 소수 초 정밀도가 보이도록 날짜·시간 텍스트를 반환합니다. `Date`는 별도의 프로필입니다. |
| `typeCast` (기본값)       | 필수                   | 직접 만든 함수는 원시 표현을 바꾸므로, 테스트하기 전까지 별도의 프로필입니다.          |

실제 적용된 프로필에는 mysql2 버전, MySQL 서버, Node 버전, 위의 각 옵션이 기록됩니다. SQLBraid는 직접 만든 `typeCast` 함수를 검사하거나 그 출력을 추론하지 않습니다. 드라이버의 원시 값과 SQLBraid의 정규 값은 서로 다른 사실입니다.

- 정확한 프로필에서 정수와 `DECIMAL` 결과는 정규 문자열입니다. 애플리케이션 경계에서 `decodeExactInteger`, `decodeExactDecimal`, 또는 애플리케이션이 고른 숫자 변환을 쓰세요.
- `FLOAT`와 `DOUBLE`은 JavaScript `number`(binary32/binary64)로 남습니다.
- `insertId`는 드라이버가 제공하는 경우 정확한 문자열입니다.
- `affectedRows`는 안전한 범위를 검사한 작업 개수입니다.
- 네이티브 MySQL SQL은 바뀌지 않고 그대로 전달됩니다. SQLBraid가 MySQL 문법을 모두 파싱한다는 뜻은 아닙니다.

정확한 정수·소수 문자열은 준비된 쿼리와 벌크 실행에서 값을 정확하게 왕복시키는, 문서화된 바인딩 경로입니다. 일반 `undefined` 바인딩은 획득 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다. `decimalNumbers`, `jsonStrings`, `dateStrings`, `typeCast`를 바꾸면 다른 프로필을 고른 것입니다. 그러면 위의 근거는 다시 테스트하기 전까지 유효하지 않습니다.

- 바인딩 전송 방식은 순서가 있는 값을 쓰는 mysql2 텍스트·위치 기반 `?`입니다.
- 스트리밍은 준비된 문장 `Execute.stream()`을 씁니다.
- `db.call()`은 루틴 결과 집합을 메모리로 읽습니다. 준비된 문장의 OUT·INOUT은 지원하지 않습니다.
- 벌크는 선택한 어댑터의 기능과 매니페스트가 증명할 때만 준비된 문장 또는 네이티브 드라이버 작업입니다.
- 일반 MySQL DML에는 공통 `RETURNING` 절이 없습니다. 그래서 SQLBraid는 반환 행을 지어내지 않습니다.
