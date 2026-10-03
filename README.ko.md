[English](README.md)

# SQLBraid

**SQL을 직접 쓰는 TypeScript 라이브러리.**

SQLBraid는 TypeScript를 위한 SQL-first 데이터 액세스 툴킷입니다. SQL은 개발자가 직접 씁니다. SQLBraid는 일반 값을 파라미터로 바인딩합니다. 읽기 쉬운 동적 SQL과 선택적 런타임 결과 검증·변환도 지원합니다.

📖 [문서](https://clickin.github.io/SQLBraid/latest/) · [시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/)

```sh
npm install sqlbraid
```

## 빠른 시작

이 `node:sqlite` 빠른 시작 예제에는 Node.js 22.18 이상이 필요합니다. 이 요구사항은 이 어댑터에만 해당합니다. 다른 runtime·driver 조합에는 각각의 요구사항과 지원 근거가 있습니다.

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

### 1. 기본적으로 안전한 바인딩

일반 `${value}` 보간은 바인드 파라미터가 됩니다. SQLBraid는 값을 SQL 텍스트에 넣지 않습니다. 식별자와 그 밖의 SQL 구조에는 다음 명시적 헬퍼를 사용하세요.
`sql.ident`, `sql.fragment`, `sql.list`, `sql.join`.

`sql.raw`는 신뢰된 SQL을 변경 없이 문장에 넣습니다. 신뢰할 수 없는 입력을 넘기지 마세요.

### 2. 읽기 쉬운 동적 SQL

`/*@braid ...*/` 지시어로 조건을 SQL 안에 직접 쓰세요. SQL은 읽기 쉬운 상태로 남습니다.

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

소스 변환이 없으면 JavaScript는 태그를 실행할 때 모든 보간 표현식을 평가합니다. 비활성 `@braid` 분기의 표현식을 건너뛰려면 `@sqlbraid/compiler`를 사용하세요.

지원 지시어: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. 결과 매핑

`sql.rows<UserRow>`는 TypeScript 결과 타입을 선언합니다. 런타임에 행을 검증하지 않습니다. 반환된 행을 검증하거나 변환하려면 [Standard Schema](https://standard-schema.dev/) 객체를 전달하세요.

다음 예제는 Zod를 사용합니다. `npm install zod`로 별도 설치하세요.

```ts
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});
```

```ts
// TypeScript 결과 타입만 선언하며 런타임 검증은 하지 않음
const rows = await db.all(sql.rows<UserRow>`SELECT id, name FROM users`);

// Standard Schema를 이용한 런타임 검증
const userQuery = sql.rows(UserSchema)`SELECT id, name FROM users`;
const user = await db.one(userQuery);
```

## 런타임 API

SQLBraid는 일반 작업에 하나의 async API를 제공합니다. 지원 기능은 어댑터마다 다릅니다. 작업을 사용하기 전에 [지원 매트릭스](https://clickin.github.io/SQLBraid/latest/reference/support/)를 확인하세요. 미지원 기능은 명시적 오류로 실패합니다. SQLBraid는 그 기능을 버퍼링하거나 흉내 내지 않습니다.

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

SQLBraid는 ORM도 query builder도 아닙니다. SQLBraid는 다음 일을 하지 않습니다.

- 임의의 SQL을 파싱해 결과 타입 추론
- 커넥션 풀 구현
- 쿼리 재시도 또는 라우팅

선택적 compiler는 guarded `@braid` 지시어만 변환합니다. 범용 SQL compiler가 아닙니다.

## 패키지 구성

대부분의 애플리케이션은 `sqlbraid`와 외부 드라이버 하나를 설치합니다. `node:sqlite`는 Node.js에 포함되어 있습니다. 드라이버에 맞는 facade 서브패스를 import하세요.

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

Bun.SQL에서는 데이터베이스 dialect를 명시적으로 선택하세요. Custom adapter 작성자는 dialect-only 서브패스 `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, `sqlbraid/mssql`을 사용할 수 있습니다. 세분화된 `@sqlbraid/*` 패키지와 tooling은 [전체 패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/)에 있습니다.

---

[시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [문서](https://clickin.github.io/SQLBraid/latest/) · [드라이버 지원](https://clickin.github.io/SQLBraid/latest/reference/support/) · [패키지 맵](https://clickin.github.io/SQLBraid/latest/reference/packages/) · [아키텍처](./docs/mental-model.md)
