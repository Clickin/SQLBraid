---
title: 코드 생성 설정
description: 메타데이터 스냅샷에서 결정적인 TypeScript 모델을 생성합니다.
---

도구용 프로젝트에 `@sqlbraid/cli`, `@sqlbraid/codegen`, 선택한 방언, 드라이버를 설치하세요. 그리고 실행 가능한 Node 설정 파일(`.mjs`, `.js`, `.cjs`)을 만드세요.

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

설정 파일이 있는 프로젝트에서 다음 명령을 실행하세요.

```bash
pnpm exec sqlbraid codegen
pnpm exec sqlbraid codegen --config ./sqlbraid.config.mjs
pnpm exec sqlbraid codegen --target main --check
pnpm exec sqlbraid codegen --json
```

메타데이터와 출력 경로는 설정 파일 기준 상대 경로입니다.

- 여러 대상을 고르려면 `--target`을 반복하세요.
- 출력을 쓰기 전에 선택한 대상을 모두 검증합니다.
- 내용이 바뀌지 않은 생성 파일은 수정 시각(mtime)이 그대로 유지됩니다.
- JSON 결과는 I/O가 성공한 뒤에만 `written`을 보고합니다.

설정 파일은 CLI가 실행하는 신뢰된 Node 코드입니다. 샌드박스가 아닙니다. 스키마 변경을 사람이 검토해야 한다면 메타데이터와 생성된 출력을 버전 관리에 넣으세요.

`TypePolicy`는 데이터베이스 컬럼 타입이 TypeScript 타입으로 매핑되는 규칙을 정의합니다. 런타임 데이터베이스 생성 시 사용한 PostgreSQL, mysql2, MariaDB 프로필 설명 객체를 코드 생성 설정에도 동일하게 전달하세요. 네이티브 JSON 컬럼은 별도로 타입을 지정하지 않으면 안전을 위해 `unknown`으로 생성되며, 타입 재정의(override)는 생성되는 TypeScript 선언만 바꿀 뿐 런타임 디코딩 동작은 바꾸지 않습니다.
