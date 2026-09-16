# Vite 통합

> TypeScript와 TSX 변환을 가로채지 않고 Vite 8에서 SQLBraid 보호 템플릿을 lowering합니다.

애플리케이션이 사용하는 SQLBraid dialect 패키지와 Vite plugin을 함께 설치하세요.

```bash
npm install sqlbraid @sqlbraid/vite
```

일반 Vite 변환보다 먼저 실행되는 framework-neutral plugin을 추가합니다.

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

`@sqlbraid/vite`는 Vite 8을 대상으로 하는 pre-transform입니다. 세분화된 `@sqlbraid/*` dialect root와 이에 대응하는 `sqlbraid/*` facade subpath에서 가져온 SQLBraid 태그를 인식합니다. 애플리케이션이 태그를 감싸는 경우 사용자 정의 태그를 설정할 수 있습니다.

```ts
sqlbraid({
  moduleSpecifier: "@acme/sql",
  tagExport: "query",
});
```

`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`를 지원하며 declaration, `node_modules`, 생성 파일과 일반적인 build output은 건너뜁니다. 잘못된 protected SQL은 원본 파일명과 line/column이 있는 Vite 진단으로 보고됩니다. 변환된 쿼리에는 downstream Vite 변환이 조합할 수 있는 non-identity source map을 반환합니다. TSX/JSX, TypeScript 문법, decorator, module format, React, TanStack 변환은 Vite/Oxc/Rolldown의 책임이며 이 plugin은 이를 transpile하지 않습니다.

## 런타임은 별도입니다

Vite는 브라우저/애플리케이션 소스를 변환합니다. 데이터베이스 실행에는 지원되는 서버 런타임과 어댑터가 별도로 필요합니다. TanStack Start finance consumer에서는 Vite 8 build와 Node 24 애플리케이션 런타임을 분리하세요. plugin은 source map을 보존하고 서버 route는 적절한 Node 어댑터(예: `node:sqlite`)로 SQLBraid database를 생성해야 합니다. Node 전용 데이터베이스 드라이버를 브라우저 bundle로 가져오지 마세요.

직접 compiler 통합이 필요하면 `@sqlbraid/vite`가 `transformSource(source, filename, options?)`를 다시 내보냅니다. 주변 TypeScript 변환은 다른 bundler가 소유할 때만 사용하세요. [동적 템플릿](/SQLBraid/v/1.0.0-rc.2/concepts/dynamic-braid.md), [SQL 태그](/SQLBraid/v/1.0.0-rc.2/concepts/sql-tags.md), [Vite package README](https://github.com/Clickin/SQLBraid/tree/main/packages/vite)도 참고하세요.
