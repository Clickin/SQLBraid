---
title: 5분 SQLite 빠른 시작
description: Node에 내장된 SQLite 드라이버로 첫 SQLBraid 쿼리를 실행합니다.
---

이 경로는 Node `>=22.18.0` 및 `node:sqlite`를 사용하며 데이터베이스 서버가 필요하지 않습니다. 첫 번째 쿼리는 단순한 태그 템플릿이므로 SQLBraid 컴파일러가 필요하지 않습니다. 두 번째 쿼리는 동적 `@braid`를 추가하고 함께 제공되는 lowering 명령을 사용합니다.

:::note 검증 상태
PV18의 profile/container migration에 대한 최종 exact-SHA Runtime, Docs,
Release gate는 아직 대기 중입니다. 기록된 PV16/PV17 revision은 역사적
SQLite 및 packed quickstart 증거일 뿐이며, npm 발행이나 현재 PV18 프로필을
인증하지 않습니다.
:::

## SQLite 표현 프로필

`node:sqlite`는 server version이 아니라 Node runtime API입니다. 프로필에는
Node와 Node에 번들된 SQLite library를 기록합니다. INTEGER는 public 결과에서
canonical `string`이며 native `bigint`는 어댑터 내부 표현일 뿐입니다.

| SQLite 표면 | 프로필 표현 | 상태/주의 |
| --- | --- | --- |
| INTEGER | JavaScript `string` | int64를 lossless하게 보존합니다. native `bigint`는 public API가 아닙니다. |
| REAL | JavaScript `number` | IEEE binary 부동소수점이며 decimal exactness를 주장하지 않습니다. |
| `STRICT` table | SQLite native affinity enforcement | schema 기능이며 SQLBraid parser 보장이 아닙니다. |
| non-STRICT table / `ANY` | SQLite dynamic value | 저장된 값과 driver에 따라 반환 표현이 달라집니다. |
| JSON1 | text | Standard Schema로 JSON text를 파싱/검증합니다. |
| BLOB | `Buffer`/bytes | binary로 유지하거나 명시적으로 encode합니다. |
| `RETURNING` | materialized rowset | 전달 전에 output을 축적하며 DML-returning stream은 주장하지 않습니다. |

Native binding은 `?` placeholder와 `StatementSync`를 사용하고, `iterate()`가
stream primitive이며 prepared loop가 bulk 전략입니다. SQLite에는
stored-procedure transport가 없으므로 등록 function과 table-valued extension은
일반 SQL row query입니다. Native SQLite SQL은 grammar rewrite 없이 전달되며,
투명성은 grammar 지원을 뜻하지 않습니다.

## 1. 프로젝트 만들기

```bash
mkdir braid-sqlite && cd braid-sqlite
npm init -y
npm pkg set type=module
npm install @sqlbraid/sqlite
npm install --save-dev typescript @types/node@22
mkdir src
```

## 2. 간단한 쿼리 하나 실행하기

`src/index.ts`를 만드세요.

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
  const requestedId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${requestedId}
  `);
  console.log(users);
} finally {
  native.close();
}
```

Node 22.18.0은 이 삭제 가능한 TypeScript를 직접 실행할 수 있습니다.

```bash
node src/index.ts
```

출력은 `[{ id: "1", name: "Ada" }]`와 같은 행 배열입니다. 요청한 ID는 드라이버에 바인드되는 값이며 SQL 텍스트에 삽입되지 않습니다.

node:sqlite 어댑터는 논리 문장을 `?` placeholder가 있는 텍스트로 만든 뒤
문서화된 `DatabaseSync.prepare(text)`와 `StatementSync` API를 사용합니다.
구체화와 힌트 검증은 statement 실행 전에 끝납니다. reuse가 필요하면
어댑터가 소유하며, SQLBraid는 문서화되지 않은 `SQLTagStore` 호출 경로를
사용하지 않습니다.

## 3. 동적 @braid 추가 및 lowering

`src/index.ts`에서 `requestedId` 선언과 쿼리 블록을 다음 코드로 바꾸세요.

```ts
const requestedId: number | undefined = 1;
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${requestedId !== undefined}*/
      AND id = ${requestedId}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
```

SQLBraid 컴파일러의 lowering으로 TypeScript 소스를 빌드한 다음 생성된 JavaScript를 실행하세요.

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

컴파일러는 보호된 템플릿을 `build/index.js`로 lowering합니다. `@braid where`는 자식이 SQL을 생성할 때만 `WHERE`를 내보내고 선행 `AND`/`OR`를 제거합니다. 조건은 보호된 값보다 먼저 평가되며, 비활성 분기의 표현식은 평가되지 않습니다. 요청한 ID는 일반적인 SQLite 바인드로 남습니다.

## 무슨 일이 일어났나요?

1. `DatabaseSync`가 메모리 SQLite 리소스를 소유합니다.
2. `createNodeSqliteDatabase(native)`가 해당 물리적 리소스를 SQLBraid 런타임에 맞춥니다.
3. `sql.rows<UserRow>`가 이 문장이 `UserRow` 형태의 행을 반환한다고 선언합니다.
4. 일반 값은 SQL 텍스트가 아닌 드라이버 바인드(SQLite에서는 `?`)가 됩니다.
5. 컴파일러는 동적 템플릿의 지연된 보호 평가를 보존합니다.

쓰기에는 `sql.command`와 `db.execute`를 사용하세요. 정확히 한 행에는 `db.one`을 사용합니다. 결과에 한 행이 없으면 카디널리티 오류가 발생합니다. [SQL 태그와 결과 종류](/SQLBraid/concepts/sql-tags/)를 참고하세요.

:::caution Node SQLite 지원
`node:sqlite`는 이 릴리스에서 사용하는 첫 번째 파티 SQLite 어댑터입니다.
SQLite 어댑터는 루틴 호출을 지원하지 않으며 스트리밍에는
`StatementSync.iterate()`를 사용합니다. INTEGER 결과는 public API에서
canonical string으로 반환되며, 정밀도가 필요한 REAL/JSON/temporal 값은
`CAST(... AS TEXT)` 또는 lossless text profile을 명시하세요. `undefined` 일반
IN 값은 acquire 전에 거부되고 `null`은 SQL `NULL`입니다. SQLite
scalar/aggregate/window function은 일반 SQL 함수이며 virtual-table/table-valued
extension도 stored procedure가 아닌 일반 행 쿼리입니다.
:::


