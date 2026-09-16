# 설정

> 런타임 설정 의존성을 추가하지 않고 codegen 대상을 구성합니다.

SQLBraid는 다음 실행 가능한 설정 이름 중 하나를 찾습니다.

```text
sqlbraid.config.mjs
sqlbraid.config.js
sqlbraid.config.cjs
```

설정은 `defineConfig({ codegen: { targets } })`를 export합니다.

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/mysql";

export default defineConfig({
  codegen: {
    targets: [{
      name: "main",
      metadata: "./db/main.metadata.json",
      outFile: "./src/generated/database.ts",
      typePolicy,
    }],
  },
});
```

경로는 설정 파일을 기준으로 합니다. TypeScript 설정은 지원되지 않습니다. 설정 코드는 일회성 worker에서 신뢰된 Node 애플리케이션 코드로 실행됩니다. 따라서 모듈 캐시 수명은 제한하지만 sandbox는 아닙니다.

tooling workspace는 `tsconfig.json`에서 TypeScript 프로젝트 컨텍스트를 찾습니다. VS Code는 SQLBraid 설정과 패키지 의존성 증거를 별도로 사용해 client를 시작할지 결정합니다. language server는 SQLBraid 설정 이름, `tsconfig*.json`, `package.json`, 지원되는 소스 확장을 감시하며 관련 없는 모든 파일을 감시하지 않습니다. workspace 요청이 새로 고쳐질 때 메타데이터와 생성된 증거의 stat을 다시 확인하지만 임의 메타데이터 JSON 파일에는 전용 file watcher가 없습니다. 런타임 패키지는 이 설정을 읽지 않습니다.
