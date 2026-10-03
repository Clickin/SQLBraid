---
title: Vite 연동
description: TypeScript·TSX 변환은 그대로 두고, Vite 8에서 SQLBraid 조건부 템플릿을 변환합니다.
---

애플리케이션의 SQLBraid 방언 패키지와 함께 Vite 플러그인을 설치하세요.

```bash
npm install sqlbraid @sqlbraid/vite
```

프레임워크와 무관한 이 플러그인을 일반 Vite 변환보다 앞에 추가하세요.

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

`@sqlbraid/vite`는 Vite 8을 대상으로 하며 사전 변환(pre-transform)으로 실행됩니다. 세분화된 `@sqlbraid/*` 방언 루트와, 그에 대응하는 `sqlbraid/*` 파사드 하위 경로에서 import한 SQLBraid 태그를 인식합니다. 애플리케이션이 태그를 감싸서 쓴다면 사용자 정의 태그를 설정하세요.

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
