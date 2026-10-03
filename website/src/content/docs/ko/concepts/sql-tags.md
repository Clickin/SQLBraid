---
title: SQL 태그와 결과 종류
description: SQL을 숨기지 않고 SQLBraid 문장이 반환하는 것을 선언합니다.
---

SQLBraid의 태그는 표준 TypeScript와 SQL 문법을 따릅니다. dialect 패키지는 구성된 `sql` 태그를 내보냅니다.

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

여기에 설명된 exact integer driver profile에서 `id` 필드는 canonical 10진
텍스트입니다. 근사 부동소수점 열의 타입은 `number`입니다. 애플리케이션에
`bigint`나 임의 정밀도 decimal이 필요하면 Standard Schema transform을
사용하세요.

일치하는 런타임 작업을 사용하세요.

- `db.all`, `db.one`, `db.maybeOne`, `db.stream`, 행 준비 쿼리는 `sql.rows`가 필요합니다.
- `db.execute`는 행, command, unknown 쿼리를 받습니다. 어댑터가 보고한 실제 결과 종류를 확인합니다.
- `db.call`은 `sql.call`용입니다. output 방향, tuple result set, 정리, 데이터베이스별 제한은 [루틴 호출](/SQLBraid/concepts/routines/)을 참고하세요.

일반 `sql` 태그는 결과 종류가 `unknown`인 쿼리를 만듭니다. 드라이버별 문장이 행이나 command 메타데이터를 반환할 수 있을 때 사용하세요. 하지만 컴파일 타임 행 타입은 얻을 수 없습니다.

## 카디널리티를 명시적으로 지정하기

```ts
const user = await db.one(sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`);
const maybeUser = await db.maybeOne(sql.rows<UserRow>`SELECT id, name FROM users WHERE email = ${email}`);
const users = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);
```

`one`은 정확히 한 행을 요구합니다. `maybeOne`은 0개 또는 1개를 허용합니다. 행이 둘 이상이거나 `one`에서 행이 0개면 SQLBraid는 카디널리티 오류를 발생시킵니다. 조용히 행 하나를 고르지 않습니다.

## 결과 종류 검사는 실행 후 수행됩니다

어댑터는 문장이 행을 만들었는지 command 메타데이터를 만들었는지 보고합니다. 쿼리가 `rows`를 선언했지만 드라이버가 command를 보고하면 SQLBraid는 실행 후 `BRAID_RESULT_KIND`를 발생시킵니다. 결과 종류 검사는 이미 완료된 루트 작업을 되돌릴 수 없습니다. 따라서 잘못된 선언 때문에 쓰기를 되돌려야 한다면 쓰기를 `db.tx(...)` 안에 두세요.

Bun 1.3.14는 `bun-sql.result-kind-metadata` guarded 조건을 사용합니다.
MySQL/MariaDB 경로에서 빈 `SELECT`와 영향 행이 0인 DML/DDL은
`BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있습니다. 이 실패는 실행 후에만
발생합니다. driver가 `command: null`과 `affectedRows: 0`을 보고하기
때문입니다. side effect가 이미 발생했을 수 있습니다.

SQLBraid는 임의 SQL에서 TypeScript 행 형태를 추론하지 않습니다. 선택한 열과 선언한 행 타입의 대응은 개발자가 책임집니다.

Set-returning function과 table-valued extension은 일반 행 쿼리입니다.
`sql.rows`, `db.all`, `db.stream`을 사용하세요. `db.call`을 사용하지 마세요.
