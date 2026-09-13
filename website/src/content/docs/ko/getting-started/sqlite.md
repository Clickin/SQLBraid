---
title: 5분 SQLite 빠른 시작
description: Node에 내장된 SQLite 드라이버로 첫 SQLBraid 쿼리를 실행합니다.
---

이 경로는 Node `>=22.18.0` 및 `node:sqlite`를 사용하며 데이터베이스 서버가 필요하지 않습니다. 첫 번째 쿼리는 단순한 태그 템플릿이므로 SQLBraid 컴파일러가 필요하지 않습니다. 두 번째 쿼리는 동적 `@braid`를 추가하고 함께 제공되는 lowering 명령을 사용합니다.

:::note 릴리스 후보
npm 패키지는 아직 배포되지 않았습니다. 아래 명령은 공개 릴리스 경로이며, 후보 검증은 [`pnpm run test:examples`](https://github.com/Clickin/SQLBraid/tree/main/examples)를 사용해 동일한 패키지를 tarball에서 설치합니다.
:::

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
  id: number;
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

출력은 `[{ id: 1, name: "Ada" }]`와 같은 행 배열입니다. 요청한 ID는 드라이버에 바인드되는 값이며 SQL 텍스트에 삽입되지 않습니다.

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
`node:sqlite`는 이 릴리스에서 사용하는 첫 번째 파티 SQLite 어댑터입니다. SQLite 어댑터는 루틴 호출을 지원하지 않으며, 스트리밍에는 네이티브 문 반복 프로토콜이 필요합니다.
:::
