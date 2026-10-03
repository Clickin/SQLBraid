# 안전한 바인딩

> 값은 드라이버 파라미터로 유지하고, SQL 구조는 명시적으로 넣습니다.

일반 보간은 모두 바인딩입니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE organization_id = ${organizationId}
    AND status = ${status}
`;
```

렌더링하면 먼저 변경할 수 없는 논리 문장 하나가 만들어집니다.

- `segments`에는 확정된 SQL 구조가 들어 있습니다.
- `parameters`에는 순서대로 값 레코드가 들어 있습니다. 각 레코드는 `value`, 선택 사항인 `interpolation`, 선택 사항인 `hint`로 구성됩니다.

불변 조건은 `segments.length === parameters.length + 1`입니다. 보간한 값은 절대 SQL 소스가 되지 않습니다.

선택한 드라이버는 순수한 바인딩 설명과 힌트 검증을 마친 뒤에야 이 문장을 실제 요청으로 바꿉니다. 물리적인 전송은 드라이버가 맡습니다. `$1`, `?`, `:1`, `@p1`, 이름 기반 바인딩, 네이티브 값 템플릿 요청 중 무엇이든 쓸 수 있습니다. 플레이스홀더 문법은 방언이나 템플릿 렌더러의 책임이 아닙니다.

데이터베이스 파라미터 타입을 명시해야 한다면 `sql.bind(value, hint)`를 쓰세요.

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, display_name
  FROM users
  WHERE display_name = ${sql.bind(displayName, mssqlParameter.nvarchar(200))}
`;
```

`${value}`는 드라이버의 기본 추론을 씁니다. `${sql.bind(value, hint)}`는 데이터베이스 파라미터 타입을 명시적으로 요청합니다. SQLBraid는 TypeScript의 `number`, `string`, `Date`에서 데이터베이스 타입을 일괄적으로 추론하지 않습니다. 이 API는 파라미터 타입을 정할 뿐, 애플리케이션 입력 검증이나 코덱 프레임워크가 아닙니다. [파라미터 타입 힌트](/SQLBraid/latest/concepts/parameter-hints.md)를 보세요.

## SQL 구조는 명시적으로 요청해야 합니다

식별자와 SQL 조각은 데이터와 다릅니다. [구조적 SQL 조각](/SQLBraid/latest/concepts/structural-fragments.md)의 명시적인 헬퍼를 쓰세요.

```ts
const order = sql.ident(sortColumn);
const query = sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY ${order}
`;
```

`sql.ident`는 식별자의 각 부분을 따옴표로 감쌉니다. `sql.raw`는 애플리케이션이 이미 신뢰하는 SQL 텍스트를 위한 탈출구입니다. 입력을 검증하거나 정제하지 않습니다. 사용자가 제어하는 텍스트를 `sql.raw`에 넘기지 마세요.

목록도 바인딩입니다.

```ts
const ids = [10, 20, 30];
const query = sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id IN (${sql.list(ids)})
`;
```

`sql.list([])`는 `BRAID_EMPTY_LIST`를 던집니다. 빈 집합에 대한 처리 방식을 직접 정하거나, 해당 절을 `@braid if`로 감싸세요.

SQLBraid의 렌더링 한도는 SQL 바이트 크기, 바인딩 개수, 구조 항목 수, 중첩 깊이를 제한합니다. 더 엄격한 한도가 필요하면 `createSqlTag({ dialect, limits })`로 설정하세요.

PostgreSQL, MySQL, SQLite는 일반 힌트를 `BRAID_BIND_HINT_UNSUPPORTED`로 명시적으로 거부합니다. 힌트를 몰래 무시하지 않습니다. PostgreSQL의 `postgresParameter.refcursor()`는 루틴 전용이며, OUT·INOUT 포털을 구분하는 데만 씁니다. 다른 데이터베이스 타입 API가 필요하면 그에 맞는 공식 Oracle 또는 SQL Server 어댑터를 쓰세요.
