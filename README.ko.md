[English](README.md)

# SQLBraid

**TypeScript에서도 SQL은 SQL 그대로.**

SQLBraid는 TypeScript의 태그드 템플릿(tagged template) 안에 순수 SQL을 그대로 작성할 수 있게 해주는 데이터 접근 라이브러리입니다. 값은 항상 안전하게 바인딩 파라미터로 분리되며, MyBatis에서 영감을 받은 동적 조건문을 SQL 주석 안에 직접 작성하고 반환 행의 타입이나 검증 스키마를 선언할 수 있습니다.

PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server 등 6개 데이터베이스 방언에 대해 공통 실행 API를 제공하며, Node.js, Bun, Deno, 브라우저(SQLite WASM), Cloudflare D1에서 동작합니다.

```ts
const users = await db.all(sql.rows<User>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/   AND name = ${name}       /*@braid end*/
    /*@braid if ${teamId != null}*/ AND team_id = ${teamId}  /*@braid end*/
  /*@braid end*/
`);
// SQL 렌더링 결과: name = null, teamId = 7  ->  (pg) SELECT id, name FROM users WHERE team_id = $1   [7]
```

[문서](https://clickin.github.io/SQLBraid/latest/) · [5분 시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [인터랙티브 미리보기](https://clickin.github.io/SQLBraid/latest/interactive-preview/) · [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)

## 제작 동기

직장에서 Java 기반 프레임워크 라이브러리를 유지보수하며 iBatis/MyBatis 스타일의 XML SQL 매퍼를 오래 사용해 왔습니다. 원하는 SQL을 제약 없이 그대로 작성하고, 동적 조건 분기를 하나의 쿼리 문맥 안에서 파악하며, 수동으로 행을 매핑하지 않아도 타입이 선언된 결과를 얻을 수 있다는 점을 선호합니다.

TypeScript 생태계에서 같은 워크플로를 찾아보았을 때 각 선택지는 아쉬운 점이 있었습니다.

- **순수 드라이버(Raw drivers):** 파라미터 바인딩은 안전하지만, 동적 `WHERE` 조건이 늘어나면 곧바로 복잡한 문자열 조립과 파라미터 인덱스 계산 코드가 됩니다.
- **쿼리 빌더(Query builders):** 타입 추론은 훌륭하지만, 이미 머릿속에 있는 SQL을 라이브러리 고유의 메서드 체이닝 DSL로 다시 번역해야 합니다.
- **ORM:** 생성된 쿼리와 객체 모델에 의존하기보다 SQL을 직접 작성하는 방식을 선호합니다.

그래서 "AI 시대에 못 만들 게 없지!"라는 생각으로 직접 만들기 시작했습니다.

SQLBraid를 만들면서 겪은 가장 큰 장벽은 **JDBC에 해당하는 표준 인터페이스의 부재**였습니다. MyBatis는 Java가 제공하는 JDBC 표준 인터페이스(`Connection`, `PreparedStatement`, `ResultSet`) 위에 올라가 있어 드라이버별 실행 계층을 직접 구현할 필요가 없습니다. 반면 JavaScript 생태계에는 `pg`, `mysql2`, `oracledb`, `tedious`, `node:sqlite`를 아우르는 표준 인터페이스가 없어 커넥션 관리, 플레이스홀더 문법(`$1`, `?`, `:1`, `@p1`), 트랜잭션, 스트리밍, 저장 프로시저 처리 방식이 모두 제각각입니다.

따라서 SQLBraid에는 MyBatis 스타일의 동적 SQL 처리기뿐 아니라, 서로 다른 JavaScript 데이터베이스 드라이버를 공통 API로 연결하는 실행 계층도 필요했습니다.

## 빠른 시작: SQLite

Node.js 22.18 이상에서는 내장 `node:sqlite` 모듈을 사용하므로 별도의 데이터베이스 서버 없이 바로 실행해 볼 수 있습니다.

```sh
pnpm add sqlbraid @sqlbraid/sqlite
```

아래 코드를 `quickstart.mts`로 저장하고 `node quickstart.mts`로 실행합니다.

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

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

> **왜 `id`가 문자열로 반환되나요?** JavaScript의 `number` 타입이 큰 정수(64비트 `BIGINT`)나 정밀한 소수(`DECIMAL`)에서 정밀도를 잃는 문제를 막기 위해, SQLBraid는 데이터베이스의 정확한 숫자 타입을 기본적으로 문자열로 반환합니다. 애플리케이션 코드에서 변환하거나 Standard Schema를 연결해 원하는 타입으로 자동 변환할 수 있습니다([데이터 표현](https://clickin.github.io/SQLBraid/latest/concepts/data-representation/) 참고).

## 빠른 시작: PostgreSQL 커넥션 풀

커넥션 풀은 사용하는 드라이버(`pg` 등)로 직접 생성하여 주입합니다. SQLBraid는 개별 작업마다 연결 하나를 대여하고, 트랜잭션 동안에는 동일한 연결을 고정합니다.

```sh
pnpm add sqlbraid @sqlbraid/postgres pg
```

```ts
import { Pool } from "pg";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);

const account = await db.one(sql.rows<{ id: string; email: string }>`
  SELECT id, email FROM accounts WHERE id = ${accountId}
`);

await db.tx(async (tx) => {
  await tx.execute(sql.command`UPDATE accounts SET active = true WHERE id = ${accountId}`);
});
```

다른 데이터베이스의 설정 방법은 각 시작 가이드를 참고하세요: [MySQL](https://clickin.github.io/SQLBraid/latest/getting-started/mysql/) · [MariaDB](https://clickin.github.io/SQLBraid/latest/getting-started/mariadb/) · [Oracle](https://clickin.github.io/SQLBraid/latest/getting-started/oracle/) · [SQL Server](https://clickin.github.io/SQLBraid/latest/getting-started/mssql/) · [브라우저 SQLite 및 Cloudflare D1](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite-browser/).

## 동작 방식

SQLBraid는 템플릿을 읽어 세 단계를 거쳐 실행할 SQL 문장을 구성합니다.

1. **지시어 평가 (`/*@braid ... */`):** 지시어는 표준 SQL 주석 문법을 따르므로 에디터와 SQL 포매터에서 일반 SQL로 정상 인식됩니다. `if`, `choose` / `when` / `otherwise`, `where`, `set`, `trim` 블록을 순서대로 평가해 거짓인 분기를 제거하며, 여러 줄 블록과 중첩 구조를 모두 지원합니다. `where`와 `set` 블록은 남은 조건문 앞의 불필요한 `AND`/`OR`나 끝의 쉼표(`,`)를 자동으로 정리합니다.
2. **파라미터 바인딩 분리 (`${value}`):** 활성화된 SQL 분기에서 사용된 값은 SQL 문자열에 직접 이어 붙이지 않고 바인딩 파라미터로 전달됩니다. 단, 선택적 컴파일러를 사용하지 않으면 JavaScript 태그드 템플릿의 동작 방식에 따라 SQLBraid가 지시어를 처리하기 전에 모든 템플릿 표현식이 먼저 평가됩니다.
3. **드라이버별 플레이스홀더 변환:** 쿼리에서는 항상 동일한 `${value}` 문법을 작성하면, 대상 드라이버 어댑터가 각 DB 규격(`$1`, `?`, `:1`, `@p1`)에 맞춰 플레이스홀더를 작성합니다.

```ts
sql.rows<User>`
  SELECT u.id, u.name
  FROM users u
  /*@braid if ${teamName != null}*/
    JOIN teams t
      ON t.id = u.team_id
     AND t.name = ${teamName}
  /*@braid end*/
  /*@braid where*/
    /*@braid if ${onlyActive}*/
      AND u.active = 1
      AND u.name IS NOT NULL
    /*@braid end*/
  /*@braid end*/
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/    ORDER BY u.name
    /*@braid when ${sort === "created"}*/ ORDER BY u.created_at DESC
    /*@braid otherwise*/                  ORDER BY u.id
  /*@braid end*/
`;
// teamName = "core", onlyActive = true  ->  ... JOIN teams t ON t.id = u.team_id AND t.name = ? WHERE u.active = 1 AND u.name IS NOT NULL ORDER BY ...
// teamName = null,   onlyActive = false ->  SELECT u.id, u.name FROM users u ORDER BY ...
```

- **무빌드 런타임 실행과 선택적 컴파일러:** 모든 지시어는 별도의 빌드 과정 없이 런타임에 바로 동작합니다. 비활성화된 `/*@braid if ...*/` 분기 내부의 `${...}` 표현식 평가 자체를 건너뛰고(지연 평가) 싶다면 선택적으로 컴파일러 플러그인(`@sqlbraid/vite`, `@sqlbraid/webpack`, `@sqlbraid/cli`)을 적용할 수 있습니다. 컴파일러는 표현식의 평가 시점만 지연 함수(thunk)로 감싸며, 최종 SQL 조립은 여전히 런타임에 수행합니다([동적 `@braid` 지시어](https://clickin.github.io/SQLBraid/latest/ko/concepts/dynamic-braid/#컴파일러가-하는-일) 참고).
- **동적 식별자 및 쿼리 조각:** 테이블명, 컬럼 목록, 하위 쿼리 조각처럼 SQL 구조 자체를 동적으로 조합해야 할 때는 명시적 헬퍼(`sql.ident`, `sql.list`, `sql.join`, `sql.fragment`)를 사용합니다([구조적 SQL 조각](https://clickin.github.io/SQLBraid/latest/concepts/structural-fragments/) 참고).

컴파일러를 쓴다면 `@sqlbraid/template`을 직접 런타임 의존성으로 설치하세요. 생성된 코드가 이 패키지의 헬퍼를 import합니다.

## 반환 타입 선언과 스키마 검증

쿼리의 성격에 따라 결과 종류를 명시적으로 선언합니다. 행 집합을 조회할 때는 `sql.rows<T>`, `INSERT`/`UPDATE`/`DELETE` 명령에는 `sql.command`, 저장 프로시저 호출에는 `sql.call`을 사용합니다. 데이터베이스가 선언한 것과 다른 결과 종류를 반환하면 예외를 발생시킵니다([SQL 태그와 결과 종류](https://clickin.github.io/SQLBraid/latest/concepts/sql-tags/) 참고). `sql.rows<T>`의 `T`는 TypeScript 타입 선언이며, 실제 행의 필드와 값을 런타임에 검증하려면 Standard Schema를 전달합니다.

**Standard Schema 연동 (Zod, Valibot, ArkType 등):**

타입 인자 대신 Standard Schema 규격을 지원하는 스키마 객체를 전달하면 런타임 행 검증과 타입 변환(예: 문자열로 반환된 숫자를 `number`나 `bigint`로 변환)을 동시에 처리할 수 있습니다([Standard Schema 결과 매핑](https://clickin.github.io/SQLBraid/latest/concepts/result-mapping/) 참고).

```ts
const user = await db.one(sql.rows(UserSchema)`SELECT id, name FROM users WHERE id = ${id}`);
```

**순수 JavaScript에서 사용하기:**

`<T>` 타입 인자 없이 `sql.rows`를 그대로 사용합니다. 반환되는 각 행은 데이터베이스 컬럼명(또는 `AS` 별칭)을 그대로 키로 가지는 일반 객체입니다. SQLBraid는 `user_id`를 `userId`로 암묵적 변환하지 않으므로, camelCase 키가 필요하면 SQL에서 직접 별칭(`SELECT user_id AS "userId"`)을 지정하세요.

## 저장 프로시저 (`db.call`)

저장 프로시저를 단순 문자열 쿼리로 취급하는 대신, `sql.call`을 통해 타입이 지정된 `OUT` 파라미터, 다중 결과 집합(result sets), 반환값(return value)을 일관되게 다룰 수 있습니다.

다음은 PostgreSQL에서 `refcursor` `OUT` 파라미터로 결과 행을 받아오는 예제입니다(PostgreSQL에서 커서를 읽으려면 열린 트랜잭션이 필요하므로 `db.tx` 내부에서 호출합니다).

```sql
CREATE PROCEDURE list_active_users(OUT users refcursor) LANGUAGE plpgsql AS $$
BEGIN
  OPEN users FOR SELECT id, name FROM users WHERE active;
END $$;
```

```ts
import type { RoutineCallResult } from "sqlbraid";
import { postgresParameter, sql } from "@sqlbraid/postgres";

interface UserRow {
  id: string;
  name: string;
}

const result = await db.tx(async (tx) =>
  tx.call(
    sql.call<RoutineCallResult<{}, [UserRow]>>`
      CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})
    `,
  ),
);

console.log(result.resultSets[0].rows); // UserRow[]: [{ id: "1", name: "Ada" }]
```

`RoutineCallResult<Output, Sets, ReturnValue>`는 스칼라 `OUT` 값의 타입, 결과 집합별 행 타입 튜플, 반환값 타입을 차례로 선언합니다. `sql.rows`와 마찬가지로 Standard Schema를 전달해 검증 및 변환할 수도 있습니다.

```ts
import { postgresParameter, sql } from "@sqlbraid/postgres";

const result = await db.tx(async (tx) =>
  tx.call(
    sql.call({ resultSets: [UserSchema] as const })`
      CALL list_active_users(${sql.out("users", postgresParameter.refcursor())})
    `,
  ),
);
```

드라이버별 상세 지원 범위는 [루틴 호출](https://clickin.github.io/SQLBraid/latest/concepts/routines/)과 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 참고하세요.

## 다른 라이브러리와의 비교

|                                | 작성하는 SQL                                           | 동적 SQL 처리                                                                          | 결과 타입                                                     | 지원 데이터베이스                                                |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Prisma**                     | Prisma 스키마와 클라이언트 API, 원시 SQL은 `$queryRaw` | 클라이언트 API (`undefined` 필터 건너뜀), 원시 SQL에서는 `Prisma.sql` 및 `Prisma.join` | 스키마에서 생성, 원시 쿼리는 직접 타입 지정                   | PostgreSQL, MySQL, SQLite, SQL Server, CockroachDB, MongoDB      |
| **Drizzle**                    | TypeScript 스키마와 쿼리 API, 원시 부분은 `sql` 템플릿 | 쿼리 API (`and(...)`가 `undefined`를 건너뜀)                                           | 스키마에서 추론                                               | PostgreSQL, MySQL, SQLite, SingleStore, Gel                      |
| **Kysely**                     | 타입 안전 쿼리 빌더, 원시 부분은 `sql` 템플릿          | 빌더 메서드 체이닝 (조건부 `.where()` 등)                                              | DB 인터페이스에서 추론                                        | PostgreSQL, MySQL, SQLite, SQL Server                            |
| **postgres.js / slonik**       | 태그드 템플릿 기반 원시 SQL                            | JS 코드에서 조각 조합 (중첩 `sql`, `sql.fragment`, `sql.join` 등)                      | 직접 선언                                                     | PostgreSQL                                                       |
| **pgtyped**                    | `:name` 파라미터를 쓰는 원시 SQL 파일                  | 내장 기능 없음 (`:name IS NULL OR ...`로 직접 작성)                                    | 실제 DB에 쿼리를 대조해 빌드 시 생성                          | PostgreSQL                                                       |
| **sqlc** (TypeScript 플러그인) | 원시 SQL 파일                                          | 내장 기능 없음 (`IS NULL OR ...`로 직접 작성)                                          | SQL과 스키마 파일로부터 생성                                  | PostgreSQL(`pg`, `postgres`), MySQL(`mysql2`), SQLite(`sqlite3`) |
| **SQLBraid**                   | 태그드 템플릿 기반 원시 SQL                            | SQL 주석 내부 지시어 (`/*@braid if ...*/`)                                             | 직접 선언 및 런타임 스키마 검증, 선택적 테이블 모델 코드 생성 | PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server           |

**SQLBraid가 적합한 경우:** 이미 SQL 중심으로 쿼리를 설계하는 팀, 선택적 검색 필터나 동적 조인이 많은 쿼리를 다루는 경우, 또는 여러 데이터베이스 엔진에 걸쳐 공통 실행 API와 저장 프로시저 호출 방식이 필요한 경우.

**SQLBraid가 하지 않는 일:**

- **ORM이 아닙니다:** 연관 관계 자동 로딩(relation loading)이나 아이덴티티 맵을 제공하지 않습니다.
- **임의의 `SELECT` 구문 타입 추론을 하지 않습니다:** 반환 행 타입을 직접 선언하거나 Standard Schema를 전달하며, 테이블 모델은 `@sqlbraid/codegen`으로 생성합니다.
- **SQL을 암묵적으로 재작성하거나 미지원 기능을 흉내 내지 않습니다:** 대상 드라이버가 지원하지 않는 기능(예: 쿼리 취소)을 호출하면 임의로 에뮬레이션하지 않고 명시적인 오류를 발생시킵니다.
- **커넥션 풀을 자체 생성하지 않습니다:** 드라이버의 풀을 주입받아 작업 단위 또는 트랜잭션 단위로 커넥션을 대여하고 반납합니다.

## 주요 실행 기능

- **트랜잭션 ([`db.tx`](https://clickin.github.io/SQLBraid/latest/runtime/transactions/)):** 세이브포인트(savepoint), 격리 수준(isolation level), 읽기 전용 모드 지원
- **세션 고정 ([`db.session`](https://clickin.github.io/SQLBraid/latest/runtime/direct-pools/)):** 여러 쿼리에 걸쳐 단일 커넥션 유지
- **스트리밍 ([`db.stream`](https://clickin.github.io/SQLBraid/latest/runtime/streaming/)):** 대용량 결과 집합의 점진적 소비
- **준비된 쿼리 및 대량 작업:** [`db.prepare(...)`](https://clickin.github.io/SQLBraid/latest/runtime/prepared/) 및 [`db.bulk(...)`](https://clickin.github.io/SQLBraid/latest/concepts/bulk/)
- **저장 프로시저 ([`db.call`](https://clickin.github.io/SQLBraid/latest/concepts/routines/)):** `OUT` 파라미터 및 다중 결과 집합 처리
- **제어 및 관측성:** `AbortSignal` 기반 쿼리 취소, [실행 옵저버](https://clickin.github.io/SQLBraid/latest/runtime/observers/), 선택적 [OpenTelemetry 스팬 및 메트릭 연동](https://clickin.github.io/SQLBraid/latest/runtime/opentelemetry/)

데이터베이스, 드라이버, 런타임별 세부 지원 여부는 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)에서 확인할 수 있습니다.

## 지원 드라이버

`sqlbraid`, 아래의 해당 방언 또는 어댑터 패키지, 대상 드라이버 패키지를 함께 설치하세요. 내장 드라이버와 Cloudflare D1 바인딩은 별도 드라이버 패키지가 필요하지 않습니다.

| 데이터베이스 또는 어댑터 | 필요한 패키지        |
| ------------------------ | -------------------- |
| PostgreSQL               | `@sqlbraid/postgres` |
| MySQL                    | `@sqlbraid/mysql`    |
| MariaDB                  | `@sqlbraid/mariadb`  |
| SQLite                   | `@sqlbraid/sqlite`   |
| Oracle                   | `@sqlbraid/oracle`   |
| SQL Server               | `@sqlbraid/mssql`    |
| Bun.SQL                  | `@sqlbraid/bun-sql`  |

`sqlbraid`는 `@sqlbraid/core`, `@sqlbraid/runtime`, `@sqlbraid/template`만 의존하며 방언·어댑터 피어 의존성은 없습니다. 사용하는 패키지를 명시적으로 설치하세요. `sql`과 방언 힌트는 패키지 루트에서, 생성 함수는 아래 어댑터 경로에서 import하세요.

2.0.0에서는 드라이버·방언 파사드 하위 경로를 제거합니다. 자체 패키지는 각자의 버전 계열을 유지합니다. 1.x에서 올리는 방법은 [업그레이드 가이드](https://clickin.github.io/SQLBraid/latest/ko/release/upgrade-from-1x/)를 보세요.

**Official**은 CI에서 지정된 드라이버 버전과 런타임을 직접 검증함을 의미하며, **Compatible**은 동일 API 규격으로 동작하지만 특정 버전이 고정 인증되지는 않았음을 뜻합니다.

| 데이터베이스                       | 드라이버                               | import 경로                       | 지원 수준  |
| ---------------------------------- | -------------------------------------- | --------------------------------- | ---------- |
| PostgreSQL                         | `pg`                                   | `@sqlbraid/postgres/pg`           | Official   |
| PostgreSQL                         | `postgres` (postgres.js)               | `@sqlbraid/postgres/postgres-js`  | Compatible |
| PostgreSQL                         | `@neondatabase/serverless` (WebSocket) | `@sqlbraid/postgres/neon`         | Compatible |
| PostgreSQL                         | `@neondatabase/serverless` (HTTP)      | `@sqlbraid/postgres/neon-http`    | Compatible |
| PostgreSQL                         | `@electric-sql/pglite`                 | `@sqlbraid/postgres/pglite`       | Compatible |
| MySQL                              | `mysql2`                               | `@sqlbraid/mysql/mysql2`          | Official   |
| MariaDB                            | `mariadb`                              | `@sqlbraid/mariadb/mariadb`       | Official   |
| SQLite                             | `node:sqlite`                          | `@sqlbraid/sqlite/node-sqlite`    | Official   |
| SQLite                             | `better-sqlite3`                       | `@sqlbraid/sqlite/better-sqlite3` | Compatible |
| SQLite                             | `@libsql/client` (libSQL)              | `@sqlbraid/sqlite/libsql`         | Compatible |
| SQLite                             | `@sqlite.org/sqlite-wasm` (브라우저)   | `@sqlbraid/sqlite/wasm`           | Official   |
| SQLite                             | Cloudflare D1 바인딩                   | `@sqlbraid/sqlite/d1`             | Compatible |
| Oracle                             | `oracledb` (Thin)                      | `@sqlbraid/oracle/oracledb`       | Official   |
| SQL Server                         | `tedious`                              | `@sqlbraid/mssql/tedious`         | Official   |
| PostgreSQL, MySQL, MariaDB, SQLite | Bun.SQL (Bun 내장)                     | `@sqlbraid/bun-sql`               | Official   |

## 선택적 개발 도구

아래 도구들은 모두 기본 런타임의 의존성이 아닌 선택적 패키지이며, 외부 런타임 의존성을 추가하지 않습니다. 전체 목록은 [패키지 구성](https://clickin.github.io/SQLBraid/latest/reference/packages/)을 참고하세요.

- **코드 생성 (`@sqlbraid/codegen`, `@sqlbraid/cli`):** 데이터베이스 스키마를 읽어 `Row`, `Insert`, `Update` 타입을 생성하며, CI 파이프라인에서 `codegen --check`로 스키마 일치 여부를 검증할 수 있습니다([코드 생성 설정](https://clickin.github.io/SQLBraid/latest/metadata/config/) 참고).
- **에디터 지원 (`@sqlbraid/language-server`, [VS Code 확장](https://marketplace.visualstudio.com/items?itemName=sqlbraid.sqlbraid-vscode)):** 태그드 템플릿 내부의 SQL 구문 진단, 자동 완성, 호버 정보를 제공합니다.
- **Vite 플러그인 (`@sqlbraid/vite`):** 빌드 시점에 지시어 표현식 컴파일러를 실행합니다([Vite 연동](https://clickin.github.io/SQLBraid/latest/getting-started/vite/) 참고).
- **Webpack, Rspack, Next.js (`@sqlbraid/webpack`):** Next.js 16의 Webpack 및 Turbopack 환경을 모두 지원하는 지시어 컴파일러 로더입니다([Next.js 예제](https://github.com/Clickin/SQLBraid/tree/main/examples/nextjs-webpack) 참고).
- **마이그레이션 (`@sqlbraid/migrate`, `@sqlbraid/cli`):** 버전 관리되는 순수 SQL 마이그레이션 파일 실행과 애플리케이션 시작 시점의 명시적 스키마 드리프트 검사를 제공합니다.
- **에이전트 스킬 ([`skills/sqlbraid`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid)):** AI 코딩 에이전트가 SQLBraid 문법에 맞는 쿼리를 작성하도록 안내하는 규칙 파일입니다.

## 예제

모든 예제 프로젝트는 패킹된 실제 배포 아티팩트를 대상으로 CI에서 통합 테스트됩니다.

| 예제                                                                                                          | 설명                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`nextjs-webpack`](https://github.com/Clickin/SQLBraid/tree/main/examples/nextjs-webpack)                     | Next.js App Router, Webpack/Turbopack 로더 설정, 동적 필터, 트랜잭션                       |
| [`bookstore-api`](https://github.com/Clickin/SQLBraid/tree/main/examples/bookstore-api)                       | PostgreSQL 기반 Hono REST API: 마이그레이션, Standard Schema 매핑, 주문 트랜잭션, 스트리밍 |
| [`sqlite-quickstart`](https://github.com/Clickin/SQLBraid/tree/main/examples/sqlite-quickstart)               | 내장 `node:sqlite`와 지시어 컴파일러를 사용하는 최소 구성 예제                             |
| [`postgres`](https://github.com/Clickin/SQLBraid/tree/main/examples/postgres)                                 | PostgreSQL 단일 클라이언트 및 커넥션 풀 사용법                                             |
| [`mysql`](https://github.com/Clickin/SQLBraid/tree/main/examples/mysql)                                       | MySQL 커넥션 풀 사용법                                                                     |
| [`codegen`](https://github.com/Clickin/SQLBraid/tree/main/examples/codegen)                                   | 메타데이터 스냅샷으로부터 `Row`, `Insert`, `Update` 타입 생성                              |
| [`opentelemetry-slow-query`](https://github.com/Clickin/SQLBraid/tree/main/examples/opentelemetry-slow-query) | OpenTelemetry 옵저버를 이용한 쿼리 스팬 및 실행 시간 메트릭 수집                           |

## 요구 사항 및 상태

- **런타임 요구 사항:** 런타임 패키지(`sqlbraid` 및 드라이버 어댑터)는 Node.js 16.20.2 이상을 지원합니다(각 DB 드라이버의 최소 요구 버전 적용, `node:sqlite` 및 CLI/빌드 도구는 Node.js 22.18 이상 필요). 활성 LTS 버전 사용을 권장합니다.
- **현재 상태:** `sqlbraid` 및 `@sqlbraid/*` 2.x. 공개 API는 시맨틱 버저닝(SemVer)을 따릅니다. [릴리스 노트](https://clickin.github.io/SQLBraid/latest/release/notes/), [현재 제한 사항](https://clickin.github.io/SQLBraid/latest/release/limitations/), [로드맵](https://clickin.github.io/SQLBraid/latest/release/roadmap/)을 참고하세요.

## 개발 방식 및 AI 활용

SQLBraid의 아키텍처와 API는 Java 및 MyBatis를 사용해 온 경험을 바탕으로 직접 설계했습니다. 모든 코드 커밋은 코딩 에이전트(주로 Codex)를 사용해 작성했으며, 세부 구현, 엣지 케이스, 보안 이슈의 독립적인 검토에는 Claude를 활용했습니다. 결과물 검토와 최종 설계 결정은 직접 수행했습니다.

SQLBraid에는 AI 런타임 의존성이 없습니다.

## 기여 및 라이선스

이슈 제보와 풀 리퀘스트를 환영합니다([CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) 참고). 이 프로젝트는 [Apache-2.0](LICENSE) 라이선스를 따릅니다.
