---
title: Override와 필터
description: 생성 관계를 좁히고 타입 증거를 명시적으로 해결합니다.
---

Codegen 옵션은 관계 선택, 이름 지정, 타입 표현을 분리합니다.

```ts
const generated = generateModels(metadata, {
  typePolicy,
  filters: {
    includeNamespaces: ["public"],
    excludeRelations: ["public.internal_events"],
    kinds: ["table"],
  },
  naming: {
    relations: { "public.user_account": "User" },
    suffixes: { row: "Row", insert: "Insert", update: "Update" },
  },
  typeOverrides: {
    databaseTypes: {
      "jsonb": { inputType: "unknown", outputType: "unknown" },
    },
    columns: {
      "public.events": {
        created_at: { outputType: 'import("./domain.js").CompactDateTime' },
      },
    },
  },
});
```

사용 가능한 필터에는 namespace/관계 포함 및 제외와 관계 `kinds`가 있습니다. Naming은 관계 모델 이름과 row/insert/update 접미사를 지원합니다. 타입 override는 입력과 출력을 독립적으로 해결합니다. 우선순위는 열 override, 데이터베이스 타입 override, TypePolicy 순입니다.

유효하지 않거나 충돌하는 명시적 이름은 요청한 이름을 조용히 바꾸는 대신 오류 진단을 생성합니다. 충돌하는 정규화 정책 항목은 `CODEGEN_AMBIGUOUS_TYPE_MAPPING`을 생성하며 해당 타입은 `unknown`으로 남습니다. Override는 생성된 TypeScript에만 영향을 주며 드라이버가 반환한 값을 변환하지 않습니다.
