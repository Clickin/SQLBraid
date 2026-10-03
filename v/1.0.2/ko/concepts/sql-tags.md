# SQL 태그와 결과 종류

> SQL을 감추지 않고, SQLBraid 문장이 무엇을 반환하는지 선언합니다.

SQLBraid 태그는 SQL을 담은 일반 TypeScript입니다. 방언 패키지는 설정된 `sql` 태그를 export합니다.

```ts
import { sql } from "sqlbraid/postgres";

const users = sql.rows<{ id: string; name: string }>`
  SELECT id, name FROM users
`;
const update = sql.command`
  UPDATE users SET last_seen_at = now() WHERE id = ${userId}
`;
const routine = sql.call({
  resultSets: [RefreshSchema] as const,
})`
  CALL refresh_users()
`;
```

이 페이지의 정확한 정수 드라이버 프로필에서 `id` 필드는 정규 십진 텍스트입니다. 근사 부동소수점 열의 타입은 `number`입니다. 애플리케이션에 `bigint`나 임의 정밀도 소수가 필요하면 Standard Schema 변환을 쓰세요.

알맞은 런타임 작업을 쓰세요.

- `db.all`, `db.one`, `db.maybeOne`, `db.stream`, 행을 반환하는 준비된 쿼리에는 `sql.rows`가 필요합니다.
- `db.execute`는 행, 명령, unknown 쿼리를 받습니다. 어댑터가 보고한 실제 결과 종류를 검사합니다.
- `db.call`은 `sql.call`용입니다. 출력 방향, 튜플 결과 집합, 정리, 데이터베이스별 한계는 [루틴 호출](/SQLBraid/v/1.0.2/concepts/routines.md)을 보세요.

일반 `sql` 태그는 결과 종류가 `unknown`인 쿼리를 만듭니다. 드라이버별 문장이 행을 반환할 수도, 명령 메타데이터를 반환할 수도 있을 때 쓰세요. 다만 컴파일 시점의 행 타입은 얻을 수 없습니다.

## 행 개수는 명시적으로 정합니다

```ts
const user = await db.one(sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`);
const maybeUser = await db.maybeOne(sql.rows<UserRow>`SELECT id, name FROM users WHERE email = ${email}`);
const users = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);
```

`one`은 정확히 한 행을 요구합니다. `maybeOne`은 0행이나 1행을 허용합니다. 행이 둘 이상이거나 `one`에서 0행이면 SQLBraid는 행 개수 오류를 던집니다. 몰래 한 행을 골라 주지 않습니다.

## 결과 종류 검사는 실행 후에 일어납니다

어댑터는 문장이 행을 만들었는지, 명령 메타데이터를 만들었는지 보고합니다. 쿼리를 `rows`로 선언했는데 드라이버가 명령이라고 보고하면, SQLBraid는 실행 후에 `BRAID_RESULT_KIND`를 던집니다. 결과 종류 검사로 이미 끝난 루트 작업을 되돌릴 수는 없습니다. 그래서 선언이 틀렸을 때 쓰기를 롤백해야 한다면 그 쓰기를 `db.tx(...)` 안에 두세요.

Bun 1.3.14는 guarded 조건 `bun-sql.result-kind-metadata`를 씁니다. MySQL·MariaDB 경로에서는 결과가 빈 `SELECT`와, 0행에 영향을 준 DML·DDL이 `BRAID_RESULT_KIND_AMBIGUOUS`를 낼 수 있습니다. 드라이버가 `command: null`과 `affectedRows: 0`을 보고하기 때문이며, 이 오류는 실행 후에만 발생합니다. 부수 효과는 이미 일어났을 수 있습니다.

SQLBraid는 임의의 SQL에서 TypeScript 행 형태를 추론하지 않습니다. 조회한 열과 선언한 행 타입이 맞는지는 개발자가 책임집니다.

집합 반환 함수와 테이블 값 확장도 일반 행 쿼리입니다. `db.call`이 아니라 `sql.rows`, `db.all`, `db.stream`을 쓰세요.
