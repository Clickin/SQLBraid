 [English](README.md)


# SQLBraid

**SQL은 그대로, 타입 안전성은 완벽하게.**

SQLBraid는 TypeScript를 위한 SQL-first 데이터 액세스 툴킷입니다. 익숙한 SQL 문법을 그대로 사용하면서 안전한 값 바인딩, 가독성 좋은 동적 SQL, 그리고 명확한 결과 매핑 기능을 제공합니다.

```sh
pnpm add sqlbraid
```

## 빠른 시작

Node.js 22.18 버전 이상에서 `quickstart.mts` 파일로 저장하고 `node quickstart.mts`를 실행해 보세요.

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
모든 `${value}` 보간법은 자동으로 바인드 파라미터로 처리됩니다. 일반적인 값을 사용할 때 SQL 인젝션을 걱정할 필요가 없습니다.

테이블 이름이나 컬럼 이름 같은 구조적 SQL이 필요한 경우, 명시적인 헬퍼를 사용합니다:
`sql.ident`, `sql.fragment`, `sql.list`, `sql.join`, `sql.raw`.

### 2. 읽기 쉬운 동적 SQL
`/*@braid ...*/` 지시어를 사용하면 SQL 문자열의 가독성을 해치지 않고 조건부 로직을 직접 구현할 수 있습니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```
지원 지시어: `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`.

### 3. 결과 매핑
제네릭을 통해 결과 타입을 정의하거나, [Standard Schema](https://standard-schema.dev/)를 사용하여 런타임 검증 및 변환을 수행할 수 있습니다.

```ts
// 단순 타입 캐스팅
const rows = await db.all(sql.rows<UserRow>`SELECT ...`);

// Standard Schema를 이용한 런타임 검증
const eventQuery = sql.rows(EventSchema)`SELECT created_at, payload FROM events`;
const event = await db.one(eventQuery, { schema: EventSchema });
```

## 런타임 API

SQLBraid는 핵심적인 DB 작업에 필요한 간결한 API를 제공합니다:

- **조회**: `db.all()`, `db.one()`, `db.maybeOne()`, `db.stream()`
- **명령**: `db.execute()`
- **프로시저**: `db.call()`
- **배치**: `db.batch()`, `db.bulk()`
- **리소스**: `db.tx()` (트랜잭션), `db.session()` (핀 고정 연결)

### 트랜잭션 및 세션
```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.all(sql.rows<{ id: string }>`SELECT id FROM accounts`);
});
```

### 준비된 쿼리 (Prepared Queries)
쿼리의 구조를 고정하여 재사용성과 성능을 높일 수 있습니다:
```ts
const byId = db.prepare("user-by-id", (id: string) => 
  sql.rows<UserRow>`SELECT id, name FROM users WHERE id = ${id}`
);

await byId.all("u_1");
```

## 패키지 구성

SQLBraid는 모듈형 구조를 가집니다. `sqlbraid` 파사드를 설치하고, 사용하는 DB에 맞는 드라이버 서브패스(예: `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/node-sqlite`)를 임포트하여 사용합니다.

| 패키지 | 역할 |
| :--- | :--- |
| `sqlbraid` | 메인 파사드 및 드라이버 서브패스 |
| `@sqlbraid/core` | 공통 계약 및 옵저버 |
| `@sqlbraid/template` | SQL 태그 및 지시어 |
| `@sqlbraid/runtime` | 실행, 트랜잭션, 스트리밍 |
| `@sqlbraid/metadata` | DB 스키마 스냅샷 |
| `@sqlbraid/codegen` | TypeScript 모델 생성 |
| `@sqlbraid/cli` | 모델 생성 및 조사를 위한 CLI |

## SQLBraid가 제공하지 않는 것
핵심 기능을 가볍게 유지하기 위해, SQLBraid는 다음을 구현하지 않습니다:
- ORM 또는 쿼리 빌더
- 완전한 SQL 파서 또는 컴파일러
- 커넥션 풀 구현 (기존 풀을 래핑하여 사용)
- 리트라이(Retry) 또는 라우팅 프레임워크

---

[시작하기](https://clickin.github.io/SQLBraid/latest/getting-started/sqlite/) · [문서](https://clickin.github.io/SQLBraid/latest/) · [아키텍처](./docs/mental-model.md)
