---
title: 안전한 바인드
description: 값을 드라이버 파라미터로 유지하고 구조적 SQL을 명시적으로 표현합니다.
---

일반 보간은 모두 바인드입니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
    AND status = ${status}
`;
```

렌더링된 텍스트에는 dialect placeholder(`$1`, `?` 등)가 포함되고 값은 어댑터에 별도로 전달됩니다. 보간했다는 이유만으로 값이 SQL 소스가 되지는 않습니다.

데이터베이스 파라미터 타입을 명시해야 할 때는 `sql.bind(value, hint)`를 사용하세요.

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
`;
```

`${value}`는 드라이버의 일반 추론을 사용합니다. `${sql.bind(value, hint)}`는 명시적인 데이터베이스 파라미터 타입을 요청합니다. SQLBraid는 TypeScript `number`, `string`, `Date`에서 보편적인 데이터베이스 타입을 추론하지 않습니다. 이 API는 애플리케이션 입력 검증이나 codec 프레임워크가 아닌 파라미터 타입 지정입니다. [파라미터 타입 힌트](/SQLBraid/concepts/parameter-hints/)를 참고하세요.

## 구조적 입력은 선택 사항입니다

식별자와 SQL 조각은 데이터와 다릅니다. [구조적 SQL 조각](/SQLBraid/concepts/structural-fragments/)의 명시적 헬퍼를 사용하세요.

```ts
const order = sql.ident(sortColumn);
const query = sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY ${order}
`;
```

`sql.ident`는 식별자 부분을 인용합니다. `sql.raw`는 애플리케이션이 이미 신뢰하는 SQL 텍스트를 위한 탈출구이며 입력을 검증하거나 정제하지 않습니다. 사용자 제어 텍스트를 `sql.raw`에 절대 전달하지 마세요.

목록도 바인드입니다.

```ts
const ids = [10, 20, 30];
const query = sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id IN (${sql.list(ids)})
`;
```

`sql.list([])`는 `BRAID_EMPTY_LIST`를 발생시킵니다. 명시적인 빈 집합 전략을 선택하거나 `@braid if`로 절을 보호하세요.

SQLBraid의 렌더링 제한은 SQL 바이트 크기, 바인드 수, 구조적 항목 수, 중첩 깊이도 제한합니다. 애플리케이션에 더 엄격한 범위가 필요하면 `createSqlTag({ dialect, limits })`를 통해 제한을 구성하세요.

PostgreSQL, MySQL, SQLite는 `BRAID_BIND_HINT_UNSUPPORTED`로 힌트가 있는 쿼리를 명시적으로 거부하며 결코 조용히 무시하지 않습니다. 데이터베이스 타입 API가 필요하면 해당하는 첫 번째 파티 Oracle 또는 SQL Server 어댑터를 사용하세요.
