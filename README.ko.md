[English](README.md)

# SQLBraid

**SQL은 그대로, TypeScript는 그대로.**

SQLBraid는 TypeScript용 SQL 중심 데이터 접근 도구입니다. SQL은 직접 작성합니다. 일반 값은 SQLBraid가 파라미터로 바인딩합니다. 읽기 쉬운 동적 SQL을 쓸 수 있고, 필요하면 결과를 런타임에 검증하거나 변환할 수도 있습니다.

📖 [문서](https://clickin.github.io/SQLBraid/latest/) · [시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 구성](https://clickin.github.io/SQLBraid/latest/reference/packages/)

```sh
npm install sqlbraid
```

## 빠른 시작

이 `node:sqlite` 예제에는 Node.js 22.18 이상이 필요합니다. 이 조건은 이 어댑터에만 해당합니다. 다른 런타임과 드라이버 조합에는 각자의 요구 사항과 지원 근거가 있습니다.

1. 예제를 `quickstart.mts`로 저장하세요.
2. `node quickstart.mts`를 실행하세요.

```ts
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
import { DatabaseSync } from "node:sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  const db = createNodeSqliteDatabase(native);

  await db.execute(sql.command`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
  const name = "Ada";
  await db.execute(sql.command`INSERT INTO users (name) VALUES (${name})`);

  const userId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(users); // [{ id: "1", name: "Ada" }]
} finally {
  native.close();
}
```

## 핵심 개념

### 1. 기본적으로 안전합니다

일반 `${value}` 보간은 모두 바인딩 파라미터가 됩니다. SQLBraid는 값을 SQL 텍스트에 직접 넣지 않습니다. 식별자 같은 SQL 구조에는 다음 헬퍼를 명시적으로 쓰세요.
`sql.ident`, `sql.fragment`, `sql.list`, `sql.join`

`sql.raw`는 신뢰할 수 있는 SQL을 그대로 문에 넣습니다. 신뢰할 수 없는 입력은 절대 넘기지 마세요.

### 2. 읽기 쉬운 동적 SQL

`/*@braid ...*/` 지시어로 조건을 SQL 안에 바로 쓸 수 있습니다. SQL은 읽기 쉬운 상태로 남습니다.

```ts
const nameFilter: string | undefined = "Ada";
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${nameFilter != null}*/
      AND name = ${nameFilter}
    /*@braid end*/
  /*@braid end*/
`;
```

소스를 변환하지 않으면, 태그가 실행될 때 JavaScript가 보간식을 모두 평가합니다. 비활성 `@braid` 분기의 식을 평가하지 않으려면 `@sqlbraid/compiler`를 쓰세요.

지원하는 지시어: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`

### 3. 결과 매핑

`sql.rows<UserRow>`는 TypeScript 결과 타입만 선언합니다. 런타임에 행을 검증하지는 않습니다. 반환된 행을 검증하거나 변환하려면 [Standard Schema](https://standard-schema.dev/) 객체를 넘기세요.

아래 예제는 Zod를 사용합니다. `npm install zod`로 따로 설치하세요.

```ts
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});
```

```ts
// Compile-time row type only; no runtime validation
const rows = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);

// Runtime validation with Standard Schema
const userQuery = sql.rows(UserSchema)`SELECT id, name FROM users`;
const user = await db.one(userQuery);
```

## 런타임 API

자주 쓰는 작업은 하나의 비동기 API로 제공합니다. 지원하는 기능은 어댑터마다 다릅니다. 기능을 쓰기 전에 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 확인하세요. 지원하지 않는 기능은 명시적인 오류로 실패합니다. SQLBraid가 버퍼링이나 흉내로 대신하지 않습니다.

- **조회**: `db.all()`, `db.one()`, `db.maybeOne()`, `db.stream()`
- **명령 (DDL/DML)**: `db.execute()`
- **프로시저**: `db.call()`
- **일괄 실행**: `db.batch()`, `db.bulk()`
- **리소스**: `db.tx()` (트랜잭션), `db.session()` (커넥션 고정)

### 트랜잭션과 세션

```ts
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM users`);
});
```

## 범위

SQLBraid는 ORM도 쿼리 빌더도 아닙니다. 다음 일은 하지 않습니다.

- 임의의 SQL을 파싱해 결과 타입을 추론하기
- 커넥션 풀 구현하기
- 쿼리를 재시도하거나 다른 곳으로 보내기

선택 사항인 컴파일러는 `@braid` 지시어만 변환합니다. 범용 SQL 컴파일러가 아닙니다.

## 패키지 구성

대부분의 애플리케이션은 `sqlbraid`와 외부 드라이버 하나를 설치합니다. `node:sqlite`는 Node.js에 들어 있습니다. 드라이버에 맞는 파사드 하위 경로를 import하세요.

| 데이터베이스    | 드라이버                  | import                    |
| :-------------- | :------------------------ | :------------------------ |
| PostgreSQL      | `pg`                      | `sqlbraid/pg`             |
| MySQL           | `mysql2`                  | `sqlbraid/mysql2`         |
| MariaDB         | MariaDB Connector/Node.js | `sqlbraid/mariadb`        |
| SQLite          | Node `node:sqlite`        | `sqlbraid/node-sqlite`    |
| SQLite          | `better-sqlite3`          | `sqlbraid/better-sqlite3` |
| SQLite          | `@libsql/client`          | `sqlbraid/libsql`         |
| SQLite          | SQLite WASM               | `sqlbraid/sqlite-wasm`    |
| SQLite          | Cloudflare D1             | `sqlbraid/d1`             |
| Oracle Database | `oracledb`                | `sqlbraid/oracledb`       |
| SQL Server      | `tedious`                 | `sqlbraid/tedious`        |
| Bun.SQL         | Bun `Bun.SQL`             | `sqlbraid/bun-sql`        |

Bun.SQL을 쓸 때는 데이터베이스 방언을 직접 지정하세요. 어댑터를 직접 만든다면 방언 전용 하위 경로 `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, `sqlbraid/mssql`을 쓸 수 있습니다. 세분화된 `@sqlbraid/*` 패키지와 도구는 [전체 패키지 구성](https://clickin.github.io/SQLBraid/latest/reference/packages/)에 있습니다.

---

[시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [문서](https://clickin.github.io/SQLBraid/latest/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 구성](https://clickin.github.io/SQLBraid/latest/reference/packages/) · [아키텍처](./docs/mental-model.ko.md)
