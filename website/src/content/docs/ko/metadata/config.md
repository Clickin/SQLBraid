---
title: Codegen 설정
description: 메타데이터 스냅샷에서 결정적인 TypeScript 모델을 생성합니다.
---

도구 프로젝트에 `@sqlbraid/cli`, `@sqlbraid/codegen`, 선택한 dialect, 드라이버를 설치하세요. 실행 가능한 Node 설정(`.mjs`, `.js`, `.cjs`)을 만듭니다.

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/postgres";

export default defineConfig({
  codegen: {
    targets: [{
      name: "main",
      metadata: "./db/main.metadata.json",
      outFile: "./src/generated/database.ts",
      typePolicy,
      filters: { includeNamespaces: ["public"] },
    }],
  },
});
```

설정이 있는 프로젝트에서 실행하세요.

```bash
sqlbraid codegen
sqlbraid codegen --config ./sqlbraid.config.mjs
sqlbraid codegen --target main --check
sqlbraid codegen --json
```

메타데이터와 출력 경로는 설정 파일을 기준으로 합니다. 반복된 `--target`은 여러 대상을 선택합니다. 출력물을 쓰기 전에 선택한 모든 대상의 검증이 완료되며, 변경되지 않은 생성 파일은 mtime을 유지합니다. JSON 결과는 I/O가 성공한 뒤에만 `written`을 보고합니다.

설정은 신뢰된 실행 가능한 Node 코드이며 sandbox가 아닙니다. 프로젝트에서 검토 가능한 스키마 변경이 필요하다면 메타데이터와 생성 출력을 버전 관리에 포함하세요.
