[English](README.md)

# SQLBraid

**SQL은 그대로, TypeScript는 그대로. 쿼리 빌더 번역 계층은 건너뜁니다.**

SQLBraid로 TypeScript에서 태그드 템플릿으로 순수 SQL을 작성합니다. 값은 항상 파라미터로 바인딩합니다. 동적 조건은 SQL 안에 둡니다. 각 쿼리가 무엇을 반환하는지는 직접 선언합니다.

PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server를 지원합니다. Node.js, Bun, Deno, 브라우저(SQLite WASM), Cloudflare D1에서 쓸 수 있습니다.

아래는 선택 조건이 두 개인 쿼리입니다. `/*@braid if ...*/` 지시어는 조건이 참일 때만 해당 줄을 남깁니다. `/*@braid where*/`는 남은 줄이 있을 때만 `WHERE`를 붙이고, 맨 앞의 `AND`를 제거합니다. 값은 바인딩된 파라미터로 데이터베이스에 전달됩니다.

```ts
const users = await db.all(sql.rows<User>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/   AND name = ${name}       /*@braid end*/
    /*@braid if ${teamId != null}*/ AND team_id = ${teamId}  /*@braid end*/
  /*@braid end*/
`);
// name = null, teamId = 7  ->  (pg) SELECT id, name FROM users WHERE team_id = $1   [7]
```

[문서](https://clickin.github.io/SQLBraid/latest/) · [5분 시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [인터랙티브 미리보기](https://clickin.github.io/SQLBraid/latest/interactive-preview/) · [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)

## 만든 이유

회사에서는 Java를 쓰고, MyBatis를 자주 씁니다. 팀이 SQL을 잘 알 때 MyBatis의 방식이 좋습니다. 원하는 SQL을 거의 그대로 쓸 수 있습니다. 동적 조건을 하나의 문장 안에 둘 수 있습니다. 행을 직접 매핑하지 않아도 타입이 있는 결과를 얻습니다.

TypeScript에서 같은 방식을 찾아봤지만 찾지 못했습니다. 순수 드라이버는 안전하지만, 동적 `WHERE` 절은 문자열 조립이 됩니다. 쿼리 빌더는 타입이 훌륭하지만, 이미 아는 SQL을 빌더 API로 다시 번역해야 합니다. ORM은 SQL을 완전히 숨깁니다.

SQLBraid는 MyBatis 방식을 TypeScript로 가져오려는 시도입니다. SQL은 SQL로 남고, 동적 SQL은 읽기 쉽게 남고, 결과는 타입을 유지합니다.

## 빠른 시작: SQLite

Node.js 22.18 이상이 필요합니다. 이 예제는 내장 `node:sqlite`를 쓰므로 데이터베이스 서버가 필요 없습니다.

```sh
npm install sqlbraid
```

`quickstart.mts`로 저장하고 `node quickstart.mts`를 실행하세요.

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

  const db = createNodeSqliteDatabase(native);
  const userId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);

  console.log(users); // [{ id: "1", name: "Ada" }]
} finally {
  native.close();
}
```

> **`id`가 왜 문자열일까요?** SQLBraid는 정확한 데이터베이스 숫자(정수, 소수)를 기본으로 문자열로 반환합니다. 큰 값이 정밀도를 잃지 않게 하기 위해서입니다. 직접 변환하거나 스키마로 변환하세요. [데이터 표현](https://clickin.github.io/SQLBraid/latest/concepts/data-representation/)을 참고하세요.

## 빠른 시작: 풀을 쓰는 PostgreSQL

PostgreSQL 서버가 있을 때 쓰는 예제입니다. `pg` 풀은 직접 만들고, SQLBraid는 작업마다 연결 하나를 가져옵니다.

```sh
npm install sqlbraid pg
```

```ts
import { Pool } from "pg";
import { createPgPoolDatabase, sql } from "sqlbraid/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);

const account = await db.one(sql.rows<{ id: string; email: string }>`
  SELECT id, email FROM accounts WHERE id = ${accountId}
`);

await db.tx(async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${accountId}`);
});
```

## 빠른 시작: 저장 프로시저

쿼리 빌더에서는 저장 프로시저를 쓰려면 보통 드라이버를 직접 호출해야 합니다. SQLBraid에서는 `CALL` 문을 쓰고 각 OUT 파라미터를 표시합니다. `db.call`은 OUT 값을 `output`에, 결과 집합을 `resultSets`에 담아 반환합니다. 드라이버가 반환값을 제공하면 `returnValue`에도 담습니다.

이 예제는 PostgreSQL과 앞선 빠른 시작의 `db`를 씁니다. 프로시저는 `refcursor` OUT 파라미터로 행을 돌려줍니다. PostgreSQL에서는 이때 열린 트랜잭션이 필요하므로 `db.tx` 안에서 호출합니다.

```sql
CREATE PROCEDURE list_active_users(OUT users refcursor) LANGUAGE plpgsql AS $$
BEGIN
  OPEN users FOR SELECT id, name FROM users WHERE active;
END $$;
```

```ts
import { postgresParameter, sql } from "sqlbraid/pg";

const result = await db.tx(async (tx) =>
  tx.call(sql.call`CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})`),
);

console.log(result.resultSets[0].rows); // [{ id: "1", name: "Ada" }]
```

OUT 파라미터, 여러 결과 집합, 반환값의 지원 범위는 드라이버마다 다릅니다. [루틴 호출](https://clickin.github.io/SQLBraid/latest/concepts/routines/)과 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 참고하세요.

다른 데이터베이스: [MySQL](https://clickin.github.io/SQLBraid/latest/getting-started/mysql/) · [MariaDB](https://clickin.github.io/SQLBraid/latest/getting-started/mariadb/) · [Oracle](https://clickin.github.io/SQLBraid/latest/getting-started/oracle/) · [SQL Server](https://clickin.github.io/SQLBraid/latest/getting-started/mssql/) · [브라우저의 SQLite와 D1](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite-browser/)

## 동작 방식

SQLBraid는 템플릿을 읽어 문장 하나를 만들고 드라이버에 넘깁니다. 세 단계입니다.

1. **지시어가 SQL 텍스트를 고릅니다.** `/*@braid ... */` 지시어는 SQL 주석이라서 에디터는 여전히 일반 SQL로 인식합니다. `if`, `when`, `where`를 순서대로 평가하고, 비활성 부분은 버립니다. 사용할 수 있는 지시어는 `if`, `choose` / `when` / `otherwise`, `where`, `set`, `trim`입니다.
2. **모든 `${value}`는 파라미터가 됩니다.** 결과는 값이 분리된 SQL 텍스트입니다. 값을 텍스트에 이어 붙이지 않습니다.
3. **플레이스홀더는 드라이버가 만듭니다.** 어디서나 같은 `${value}`를 씁니다. 드라이버 어댑터가 `$1`, `?`, `:1`, `@p1`로 바꿉니다.

```ts
sql.rows<User>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/    ORDER BY name
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC
    /*@braid otherwise*/                  ORDER BY id
  /*@braid end*/
`;
// sort = "created"  ->  SELECT id, name FROM users ORDER BY created_at DESC
```

지시어는 빌드 단계 없이 런타임에 동작합니다. 비활성 분기의 `${...}` 표현식까지 평가하지 않으려면 선택 사항인 컴파일러(`@sqlbraid/cli` 또는 Vite 플러그인)를 실행하세요. [dynamic @braid](https://clickin.github.io/SQLBraid/latest/concepts/dynamic-braid/)를 참고하세요.

테이블 이름, 컬럼 목록, 조각 같은 SQL 구조를 문장에 넣어야 하면 명시적인 헬퍼 `sql.ident`, `sql.list`, `sql.join`, `sql.fragment`를 씁니다. [구조 조각](https://clickin.github.io/SQLBraid/latest/concepts/structural-fragments/)을 참고하세요.

## 쿼리가 반환하는 것

**결과를 선언합니다.** 행을 반환하는 쿼리는 `sql.rows<T>`, INSERT/UPDATE/DELETE는 `sql.command`, 저장 프로시저는 `sql.call`을 씁니다. 선언이 데이터베이스가 실제로 반환한 것과 다르면, 조용히 잘못된 데이터를 주지 않고 오류가 납니다.

**Standard Schema 라이브러리(Zod, Valibot, ArkType 등)로 행을 검증할 수 있습니다.**

```ts
const user = await db.one(sql.rows(UserSchema)`SELECT id, name FROM users WHERE id = ${id}`);
```

### JavaScript에서 쓰기

SQLBraid는 순수 JavaScript에서도 동작합니다. `sql.rows`를 `<T>` 타입 인자 없이 쓰면 됩니다.

- 각 행은 일반 객체입니다. 키는 데이터베이스가 반환한 컬럼 이름 또는 별칭 그대로입니다.
- SQLBraid는 이름을 **변환하지 않습니다.** `user_id`는 `user_id`로 남고 `userId`가 되지 않습니다. camelCase 키가 필요하면 SQL에서 별칭을 씁니다. 예: `SELECT user_id AS "userId"` (따옴표 규칙은 데이터베이스마다 다릅니다).
- 값은 TypeScript와 같은 규칙을 따릅니다. 정확한 숫자는 문자열이고, `null`은 `null`입니다.

```js
const rows = await db.all(sql.rows`SELECT id, created_at FROM users`);
// [{ id: "1", created_at: ... }]   (키는 SQL 컬럼과 같습니다)
```

## 비슷한 라이브러리

아래 도구는 모두 훌륭합니다. 다만 선택한 트레이드오프가 다릅니다.

|                                | 작성하는 SQL                                           | 동적 SQL                                                   | 결과 타입                                                   | 데이터베이스                                                     |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| **Prisma**                     | Prisma 스키마와 클라이언트 API, 원시 SQL은 탈출구      | 클라이언트 API로                                           | 스키마에서 생성                                             | 다수                                                             |
| **Drizzle**                    | TypeScript 스키마와 쿼리 API, 원시 부분은 `sql` 템플릿 | 쿼리 API로                                                 | 스키마에서 추론                                             | 다수                                                             |
| **Kysely**                     | 타입 안전한 쿼리 빌더                                  | 빌더 메서드 체이닝                                         | DB 인터페이스에서 추론                                      | 다수                                                             |
| **postgres.js / slonik**       | 태그드 템플릿의 원시 SQL                               | JS에서 조각을 조합                                         | 직접 선언                                                   | PostgreSQL                                                       |
| **pgtyped**                    | 원시 SQL 파일                                          | 쿼리 조합 없음. SQL에서 `:name IS NULL OR ...`로 직접 처리 | SQL을 데이터베이스에 대조해 생성                            | PostgreSQL                                                       |
| **sqlc** (TypeScript 플러그인) | 원시 SQL 파일                                          | 지원하지 않음                                              | SQL을 데이터베이스에 대조해 생성                            | PostgreSQL(`pg`, `postgres`), MySQL(`mysql2`), SQLite(`sqlite3`) |
| **SQLBraid**                   | 태그드 템플릿의 원시 SQL                               | SQL 안의 지시어                                            | 직접 선언하고 런타임에 검사. 테이블 모델은 선택적 코드 생성 | PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server           |

이런 경우에 SQLBraid를 선택하세요. 이미 SQL로 생각하는 경우, 쿼리에 선택 조건이 많은 경우, 여러 데이터베이스에서 같은 API가 필요한 경우입니다.

관계를 자동으로 로드하고 싶거나, 임의의 `SELECT`에서 결과 타입을 추론하고 싶다면 다른 도구를 선택하세요. SQLBraid는 이 중 어느 것도 하지 않습니다.

## SQLBraid가 하지 않는 일

- ORM이 아닙니다. 관계 로딩, 아이덴티티 맵이 없습니다.
- 임의의 `SELECT`의 타입을 추론하지 않습니다. 행 타입을 선언하거나 코드 생성으로 테이블 모델을 만드세요.
- SQL을 고쳐 쓰거나 없는 데이터베이스 기능을 흉내 내지 않습니다. 드라이버가 할 수 없는 일(예: 쿼리 취소)은 명시적인 오류가 납니다.
- 커넥션 풀을 만들지 않습니다. 드라이버로 풀을 만들어 넘기세요. 그러면 SQLBraid가 작업마다 연결 하나를, 트랜잭션에는 연결 하나를 통째로 씁니다.

## 기능

- 세이브포인트, 격리 수준, 읽기 전용 모드를 지원하는 트랜잭션: `db.tx(...)`
- 연결 하나를 유지하는 세션: `db.session(...)`
- 큰 결과의 스트리밍: `db.stream(...)`
- 준비된 쿼리: `db.prepare(...)`
- 대량 삽입/수정: `db.bulk(...)`
- OUT 파라미터와 여러 결과 집합을 가진 저장 프로시저: `db.call(...)`
- `AbortSignal`을 이용한 취소
- 로깅용 쿼리 옵저버, 선택적 OpenTelemetry 스팬과 메트릭

지원 범위는 드라이버마다 다릅니다. 데이터베이스, 드라이버, 런타임별로 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 확인하세요.

## 지원 드라이버

`sqlbraid`와 드라이버를 설치하고, 맞는 하위 경로를 import하세요. postgres.js, Neon, PGlite 어댑터는 `@sqlbraid/postgres`에서 오므로, 이 경우에는 `sqlbraid` 대신 그 패키지를 설치하세요.

| 데이터베이스                       | 드라이버               | import                           |
| ---------------------------------- | ---------------------- | -------------------------------- |
| PostgreSQL                         | `pg`                   | `sqlbraid/pg`                    |
| PostgreSQL                         | postgres.js            | `@sqlbraid/postgres/postgres-js` |
| PostgreSQL                         | Neon (WebSocket)       | `@sqlbraid/postgres/neon`        |
| PostgreSQL                         | Neon (HTTP)            | `@sqlbraid/postgres/neon-http`   |
| PostgreSQL                         | PGlite                 | `@sqlbraid/postgres/pglite`      |
| MySQL                              | `mysql2`               | `sqlbraid/mysql2`                |
| MariaDB                            | `mariadb`              | `sqlbraid/mariadb`               |
| SQLite                             | `node:sqlite`          | `sqlbraid/node-sqlite`           |
| SQLite                             | `better-sqlite3`       | `sqlbraid/better-sqlite3`        |
| SQLite                             | libSQL                 | `sqlbraid/libsql`                |
| SQLite                             | SQLite WASM (브라우저) | `sqlbraid/sqlite-wasm`           |
| SQLite                             | Cloudflare D1          | `sqlbraid/d1`                    |
| Oracle                             | `oracledb` (Thin)      | `sqlbraid/oracledb`              |
| SQL Server                         | `tedious`              | `sqlbraid/tedious`               |
| PostgreSQL, MySQL, MariaDB, SQLite | Bun.SQL                | `sqlbraid/bun-sql`               |

## 선택 도구

런타임 의존성이 아닙니다.

- **코드 생성** (`@sqlbraid/codegen`, `@sqlbraid/cli`): 데이터베이스 스키마를 읽어 `Row`, `Insert`, `Update` 타입을 생성합니다. CI에서 `codegen --check`를 실행할 수 있습니다.
- **에디터 지원** (`@sqlbraid/language-server`, [VS Code 확장](https://marketplace.visualstudio.com/items?itemName=sqlbraid.sqlbraid-vscode)): 템플릿 안의 SQL에 진단, 자동 완성, 호버를 제공합니다.
- **Vite 플러그인** (`@sqlbraid/vite`): 빌드에서 지시어 컴파일러를 실행합니다.
- **마이그레이션** (`@sqlbraid/migrate`): 버전이 있는 SQL 파일과 명시적인 시작 시 검사입니다. 마이그레이션은 SQL 파일일 뿐이고, 데이터베이스를 만들어도 자동으로 실행되지 않습니다. `migrate` 명령은 `@sqlbraid/cli`에 있습니다.

모든 패키지는 [패키지 구성](https://clickin.github.io/SQLBraid/latest/reference/packages/)을 참고하세요.

## 상태

버전 1.x입니다. 공개 API는 안정적이며 시맨틱 버전(semantic versioning)을 따릅니다. [릴리스 노트](https://clickin.github.io/SQLBraid/latest/release/notes/), [현재 제한 사항](https://clickin.github.io/SQLBraid/latest/release/limitations/), [로드맵](https://clickin.github.io/SQLBraid/latest/release/roadmap/)을 참고하세요.

## AI 사용에 대해

구현의 일부, 여섯 개 데이터베이스에 걸친 테스트, 코드 리뷰, 문서 작성에 AI 코딩 어시스턴트를 썼습니다. 설계와 API 결정은 제가 했습니다. SQLBraid에는 AI 런타임 의존성이 없습니다.

## 기여

이슈와 풀 리퀘스트를 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요. 보안 문제는 [SECURITY.md](SECURITY.md)를 참고하세요.

## 라이선스

[Apache-2.0](LICENSE)
