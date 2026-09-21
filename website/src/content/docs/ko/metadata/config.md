---
title: Codegen 설정
description: 메타데이터 스냅샷에서 결정적인 TypeScript 모델을 생성합니다.
---

도구 프로젝트에 `@sqlbraid/cli`, `@sqlbraid/codegen`, 선택한 dialect, 드라이버를 설치하세요. 실행 가능한 Node 설정(`.mjs`, `.js`, `.cjs`)을 만듭니다.

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

설정이 있는 프로젝트에서 실행하세요.

```bash
sqlbraid codegen
sqlbraid codegen --config ./sqlbraid.config.mjs
sqlbraid codegen --target main --check
sqlbraid codegen --json
```

메타데이터와 출력 경로는 설정 파일을 기준으로 합니다. 반복된 `--target`은 여러 대상을 선택합니다. 출력물을 쓰기 전에 선택한 모든 대상의 검증이 완료되며, 변경되지 않은 생성 파일은 mtime을 유지합니다. JSON 결과는 I/O가 성공한 뒤에만 `written`을 보고합니다.

설정은 신뢰된 실행 가능한 Node 코드이며 sandbox가 아닙니다. 프로젝트에서 검토 가능한 스키마 변경이 필요하다면 메타데이터와 생성 출력을 버전 관리에 포함하세요.

선택한 TypePolicy는 단순한 codegen 옵션이 아니라, 데이터 표현 방식(representation profile)을 정의하는 설정입니다.
같은 PostgreSQL/mysql2/MariaDB profile descriptor를 runtime과 이 설정에서
재사용하세요. Native JSON root는 driver 계약이 좁히지 않는 한 의도적으로
`unknown`이며, 수동 output override는 TypeScript 출력만 바꾸고 runtime
decode를 바꾸지 않습니다.
