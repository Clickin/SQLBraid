---
title: 설정
description: 코드 생성 대상을 설정합니다. 런타임 설정 의존성은 추가되지 않습니다.
---

SQLBraid는 다음 실행 가능한 설정 파일 이름 중 하나를 찾습니다.

```text
sqlbraid.config.mjs
sqlbraid.config.js
sqlbraid.config.cjs
```

설정 파일은 `defineConfig({ codegen: { targets } })`를 export합니다.

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/mysql";

export default defineConfig({
  codegen: {
    targets: [
      {
        name: "main",
        metadata: "./db/main.metadata.json",
        outFile: "./src/generated/database.ts",
        typePolicy,
      },
    ],
  },
});
```

경로는 설정 파일 기준 상대 경로입니다. TypeScript 설정 파일은 지원하지 않습니다. 설정 코드는 일회용 워커 안에서 신뢰된 Node 애플리케이션 코드로 실행됩니다. 이렇게 하면 모듈 캐시의 수명이 제한되지만, 샌드박스는 아닙니다.

- 도구 워크스페이스는 `tsconfig.json`에서 TypeScript 프로젝트 문맥을 찾습니다.
- VS Code는 SQLBraid 설정 파일과 패키지 의존성을 각각 확인해 클라이언트를 시작할지 정합니다.
- 언어 서버는 SQLBraid 설정 파일 이름, `tsconfig*.json`, `package.json`, 지원하는 소스 확장자를 감시합니다. 관련 없는 파일까지 모두 감시하지는 않습니다.
- 워크스페이스 요청이 새로 고쳐질 때 메타데이터와 생성 근거를 `stat`으로 다시 확인합니다. 임의의 메타데이터 JSON 파일에는 전용 파일 감시자가 없습니다.
- 런타임 패키지는 이 설정을 읽지 않습니다.
