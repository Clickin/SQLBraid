[English](README.md)

# SQLBraid

**SQL을 직접 쓰는 TypeScript 라이브러리.**

SQLBraid는 TypeScript를 위한 SQL-first 데이터 액세스 툴킷입니다. 개발자가 작성한 SQL을 그대로 유지하면서 일반 값 바인딩, 읽기 쉬운 동적 SQL, 선택적 런타임 결과 검증과 변환을 제공합니다.

📖 [문서](https://clickin.github.io/SQLBraid/latest/) · [시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/)

```sh
npm install sqlbraid
```

## 빠른 시작

이 `node:sqlite` 빠른 시작 예제에는 Node.js 22.18 이상이 필요합니다. 이는 해당 어댑터의 요구사항이며, 다른 runtime·driver 조합은 각각 별도의 요구사항과 지원 근거를 가집니다. 아래 코드를 `quickstart.mts`로 저장하고 `node quickstart.mts`로 실행하세요.

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

### 1. 기본적으로 안전한 바인딩

일반 `${value}` 보간은 바인드 파라미터가 되며 값이 SQL 텍스트에 삽입되지 않습니다. 식별자 등 SQL 구조는 명시적 헬퍼를 사용합니다.
`sql.ident`, `sql.fragment`, `sql.list`, `sql.join`을 사용할 수 있습니다.

`sql.raw`는 신뢰된 SQL을 그대로 삽입하는 escape hatch입니다. 신뢰할 수 없는 입력을 넘기지 마세요.

### 2. 읽기 쉬운 동적 SQL

`/*@braid ...*/` 지시어를 사용하면 SQL 문자열의 가독성을 해치지 않고 조건부 로직을 직접 구현할 수 있습니다.

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

소스 변환을 하지 않으면 템플릿 보간의 JavaScript 표현식은 태그 호출 시 평가됩니다. 비활성 `@braid` 분기에서 지연 평가를 보장하려면 `@sqlbraid/compiler`로 변환하세요.

지원 지시어: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. 결과 매핑

`sql.rows<UserRow>`는 TypeScript 결과 타입을 선언할 뿐, 행을 런타임에 검증하지 않습니다. 반환 행을 검증하거나 변환하려면 [Standard Schema](https://standard-schema.dev/) 객체를 전달하세요.

아래 예제는 Zod를 사용합니다. Zod는 별도로 `npm install zod`로 설치하세요.

```ts
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});
```

```ts
// TypeScript 결과 계약만 선언하며 런타임 검증은 하지 않음
const rows = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);

// Standard Schema를 이용한 런타임 검증
const userQuery = sql.rows(UserSchema)`SELECT id, name FROM users`;
const user = await db.one(userQuery);
```

## 런타임 API

SQLBraid는 일반 작업에 공통 async API를 제공합니다. 개별 기능은 어댑터마다 지원 여부가 다르므로 사용 전 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 확인하세요. 미지원 기능은 버퍼링하거나 흉내 내지 않고 명시적으로 실패합니다.

- **조회**: `db.all()`, `db.one()`, `db.maybeOne()`, `db.stream()`
- **명령 (DDL/DML)**: `db.execute()`
- **프로시저**: `db.call()`
- **배치**: `db.batch()`, `db.bulk()`
- **리소스**: `db.tx()` (트랜잭션), `db.session()` (커넥션 고정 연결)

### 트랜잭션 및 세션

```ts
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM users`);
});
```

## 범위

SQLBraid는 ORM이나 query builder가 아닙니다. 임의의 SQL에서 결과 타입을 추론하지 않으며, 커넥션 풀·자동 재시도·쿼리 라우팅을 구현하지 않습니다. 선택적 compiler는 guarded `@braid` 지시문을 변환하며, 범용 SQL compiler는 아닙니다.

## 패키지 구성

대부분의 애플리케이션은 `sqlbraid`와 선택한 외부 드라이버를 설치합니다. `node:sqlite`는 Node.js에 내장되어 있습니다. 드라이버에 맞는 facade 서브패스를 사용하세요.

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

Bun.SQL은 데이터베이스 dialect를 명시적으로 선택해야 합니다. Custom adapter를 작성한다면 dialect-only 서브패스인 `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, `sqlbraid/mssql`을 사용하세요. [전체 패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/)에서 세분화된 `@sqlbraid/*` 패키지와 tooling을 확인할 수 있습니다.

---

[시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [문서](https://clickin.github.io/SQLBraid/latest/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/) · [아키텍처](./docs/mental-model.md)
