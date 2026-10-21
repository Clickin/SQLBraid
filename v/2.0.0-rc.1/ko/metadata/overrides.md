# 재정의와 필터

> 생성할 릴레이션을 좁히고, 타입 근거를 명시적으로 정합니다.

codegen 옵션은 릴레이션 선택, 이름 규칙, 타입 표현을 서로 분리합니다.

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
      jsonb: { inputType: "unknown", outputType: "unknown" },
    },
    columns: {
      "public.events": {
        created_at: { outputType: 'import("./domain.js").CompactDateTime' },
      },
    },
  },
});
```

같은 런타임 표현 방식 프로필의 TypePolicy를 넘기세요. 재정의는 생성되는 TypeScript에 대한 결정일 뿐입니다. 파싱된 값이나 네이티브 값을 무손실로 만들 수 없고, 컨테이너를 보장할 수도 없습니다.

- 필터에는 네임스페이스·릴레이션의 포함·제외와 릴레이션 `kinds`가 있습니다.
- 이름 규칙은 릴레이션 모델 이름과 row, insert, update 접미사를 지원합니다.
- 타입 재정의는 입력과 출력에 대해 따로 결정됩니다. 우선순위는 열 재정의, 데이터베이스 타입 재정의, TypePolicy 순입니다.

잘못되었거나 서로 겹치는 명시적 이름은 오류 진단을 냅니다. codegen은 요청한 이름을 몰래 바꾸지 않습니다. 정규화한 정책 항목이 서로 충돌하면 `CODEGEN_AMBIGUOUS_TYPE_MAPPING`이 나고, 해당 타입은 `unknown`으로 남습니다. 재정의는 생성되는 TypeScript에만 영향을 줍니다. 드라이버가 반환하는 값을 변환하지 않습니다.
