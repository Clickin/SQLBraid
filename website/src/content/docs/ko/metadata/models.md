---
title: Row, Insert, Update 모델
description: 생성된 선언과 보수적인 증거 규칙을 이해합니다.
---

`generateModels(metadata, options)`는 순수한 offline 함수입니다. 독립 실행 가능한 TypeScript 소스, 모델 이름, 진단, 메타데이터/정책 provenance, options hash를 반환합니다.

숫자 identity `id`, 필수 `email`, 생성 또는 쓰기 불가 증거가 없는 테이블의 경우 codegen은 다음을 출력합니다.

```ts
export interface UsersRow {
  id: number;
  email: string;
}

export interface UsersInsert {
  id?: number;
  email: string;
}

export interface UsersUpdate {
  id?: number;
  email?: string;
}
```

- **Row**는 TypePolicy의 `outputType`을 사용하며, 데이터베이스 nullable은 `| null`을 추가합니다.
- **Insert**는 `inputType`을 사용합니다. nullable/default/identity 열은 optional이 되고, 삽입할 수 없거나 생성된 것으로 입증된 열은 제외됩니다.
- **Update**는 `inputType`을 사용합니다. 포함된 속성은 optional이며, 업데이트할 수 없거나 생성된 것으로 입증된 열은 제외됩니다. identity만으로 금지하지는 않습니다.

View, materialized view, foreign, virtual 관계에는 Row 모델만 부여됩니다. 열이 있는 알 수 없는 관계 종류에는 경고와 함께 Row 모델이 부여됩니다. 지원되지 않거나 입증되지 않은 타입은 `any`가 아니라 계속 `unknown`입니다. 생성된 소스를 사용하기 전에 진단을 확인하세요.

열 이름은 필요한 경우 인용된 TypeScript 속성으로 정확한 데이터베이스 키를 유지합니다. namespace 증거와 안정적인 identity 접미사가 충돌을 방지합니다. 결정적인 출력은 메타데이터 캡처 타임스탬프나 객체 삽입 순서에 의존하지 않습니다.
