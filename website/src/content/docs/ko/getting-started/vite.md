---
title: Vite 연동
description: TypeScript·TSX 변환은 그대로 두고, Vite 8에서 SQLBraid 조건부 템플릿을 변환합니다.
---

이 페이지에는 Node `>=22.18.0`이 필요합니다. 예제는 메모리 SQLite를 쓰므로 데이터베이스 서버가 필요 없습니다.

## 1. 프로젝트 만들기

애플리케이션의 SQLBraid 방언 패키지와 함께 Vite 플러그인을 설치하세요.
다음 명령은 SQLite를 사용합니다.

```bash
mkdir braid-vite-app && cd braid-vite-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite @sqlbraid/template
pnpm add --save-dev vite @sqlbraid/vite
mkdir src
```

생성된 코드는 `@sqlbraid/template`에서 헬퍼를 import합니다. 애플리케이션의 직접 런타임 의존성으로 유지하세요.

## 2. 플러그인 추가하기

프레임워크와 무관한 이 플러그인을 일반 Vite 변환보다 앞에 추가하세요. 이 코드를 `vite.config.ts`로 저장하세요.

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

## 3. 동적 쿼리 작성하기

이 코드를 `src/main.ts`로 저장하세요.

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
native.exec("INSERT INTO users (name) VALUES ('Ada'), ('Grace')");

const db = createNodeSqliteDatabase(native);
const name: string | null = "Ada";
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
native.close();
```

## 4. 빌드하고 실행하기

Node용으로 파일을 빌드한 다음 결과를 실행하세요.

```bash
pnpm exec vite build --ssr src/main.ts
node dist/main.js
```

출력은 `[{ id: '1', name: 'Ada' }]`입니다. `AND name = ...` 줄은 `name`이 `null`이 아닐 때만 SQL에 남습니다.

## 플러그인 옵션

`@sqlbraid/vite`는 Vite 8을 대상으로 하며 사전 변환으로 실행됩니다. `@sqlbraid/*` 방언 루트와 `@sqlbraid/template`에서 import한 태그를 인식합니다. 애플리케이션이 태그를 감싸서 쓴다면 사용자 정의 태그를 설정하세요.

```ts
sqlbraid({
  moduleSpecifier: "@acme/sql",
  tagExport: "query",
});
```

플러그인의 동작은 다음과 같습니다.

- `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`를 지원합니다.
- 선언 파일, `node_modules`, 생성된 파일, 일반적인 빌드 출력은 건너뜁니다.
- 잘못된 조건부 SQL은 원래 파일 이름, 줄, 열과 함께 Vite 진단으로 보고합니다.
- 변환한 쿼리에는 항등이 아닌 소스 맵을 반환합니다. 그래서 뒤따르는 Vite 변환이 소스 맵을 이어 붙일 수 있습니다.

TSX/JSX, TypeScript 문법, 데코레이터, 모듈 형식, React·TanStack 변환은 계속 Vite, Oxc, Rolldown이 맡습니다. 이 플러그인은 이것들을 트랜스파일하지 않습니다.

## 런타임은 별개입니다

Vite는 브라우저와 애플리케이션의 소스를 변환합니다. 데이터베이스 실행에는 여전히 지원되는 서버 런타임과 어댑터가 필요합니다.

TanStack Start 금융 예제에서는 Vite 8 빌드와 Node 24 애플리케이션 런타임을 별개로 다루세요.

- 플러그인은 소스 맵을 유지해야 합니다.
- 서버 라우트는 `node:sqlite` 같은 올바른 Node 어댑터로 SQLBraid 데이터베이스를 만들어야 합니다.
- Node 전용 데이터베이스 드라이버를 브라우저 번들에 import하지 마세요.

컴파일러를 직접 연동한다면 `@sqlbraid/vite`가 재export하는 `transformSource(source, filename, options?)`를 쓸 수 있습니다. 주변의 TypeScript 변환을 다른 번들러가 맡을 때만 쓰세요. [동적 템플릿](/SQLBraid/concepts/dynamic-braid/), [SQL 태그](/SQLBraid/concepts/sql-tags/), [Vite 패키지 README](https://github.com/Clickin/SQLBraid/tree/main/packages/vite)를 보세요.
