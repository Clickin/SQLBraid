---
title: Codegen 설정
description: 메타데이터 스냅샷에서 결정적인 TypeScript 모델을 생성합니다.
---

도구 프로젝트에 `@sqlbraid/cli`, `@sqlbraid/codegen`, 선택한 dialect, 드라이버를 설치하세요. 실행 가능한 Node 설정(`.mjs`, `.js`, `.cjs`)을 만드세요.

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicyForProfile } from "@sqlbraid/postgres";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });

export default defineConfig({
  codegen: {
    targets: [
      {
        name: "main",
        metadata: "./db/main.metadata.json",
        outFile: "./src/generated/database.ts",
        typePolicy,
        filters: { includeNamespaces: ["public"] },
      },
    ],
  },
});
```

설정이 있는 프로젝트에서 다음 명령을 실행하세요.

```bash
sqlbraid codegen
sqlbraid codegen --config ./sqlbraid.config.mjs
sqlbraid codegen --target main --check
sqlbraid codegen --json
```

메타데이터와 출력 경로는 설정 파일 기준 상대 경로입니다.

- 여러 대상을 선택하려면 `--target`을 반복하세요.
- 출력을 쓰기 전에 선택한 모든 대상의 검증이 끝납니다.
- 변경되지 않은 생성 파일은 mtime을 유지합니다.
- JSON 결과는 I/O가 성공한 뒤에만 `written`을 보고합니다.

설정은 CLI가 실행하는 신뢰된 Node 코드입니다. sandbox가 아닙니다. 프로젝트에 검토 가능한 스키마 변경이 필요하면 메타데이터와 생성 출력을 버전 관리에 넣으세요.

선택한 TypePolicy는 representation profile입니다. 단순한 codegen 옵션이
아닙니다. 같은 PostgreSQL/mysql2/MariaDB profile descriptor를 runtime과 이
설정에서 사용하세요. Native JSON root는 driver 선언이 좁히지 않으면
의도적으로 `unknown`입니다. 수동 output override는 생성되는 TypeScript만
바꿉니다. runtime decode는 바꾸지 않습니다.
