---
title: Row, Insert, Update 모델
description: 생성된 선언과 보수적인 증거 규칙을 설명합니다.
---

`generateModels(metadata, options)`는 순수한 offline 함수입니다. 독립 TypeScript 소스, 모델 이름, 진단, 메타데이터/정책 provenance, options hash를 반환합니다.

숫자 identity `id`, 필수 `email`이 있고, 생성 열이나 쓰기 불가 열의 증거가 없는 테이블을 예로 듭니다. 이 테이블에 대해 codegen은 다음을 출력합니다.

```ts
export interface UsersRow {
  id: string;
  email: string;
}

export interface UsersInsert {
  id?: string;
  email: string;
}

export interface UsersUpdate {
  id?: string;
  email?: string;
}
```

- **Row**는 TypePolicy의 `outputType`을 사용합니다. 데이터베이스 nullable은 `| null`을 추가합니다.
- **Insert**는 `inputType`을 사용합니다. nullable/default/identity 열은 optional입니다. 삽입할 수 없거나 생성된 것으로 입증된 열은 제외됩니다.
- **Update**는 `inputType`을 사용합니다. 포함된 속성은 optional입니다. 업데이트할 수 없거나 생성된 것으로 입증된 열은 제외됩니다. identity만으로는 열을 제외하지 않습니다.

정확한 정수와 10진수의 output type은 canonical `string`입니다. 근사 이진
타입은 `number`입니다. 생성된 모델은 exact string을 `bigint`나 decimal 객체로
조용히 디코드하지 않습니다.

View, materialized view, foreign, virtual 관계는 Row 모델만 받습니다. 열이 있는 알 수 없는 관계 종류는 Row 모델과 경고를 받습니다. 지원되지 않거나 입증되지 않은 타입은 계속 `unknown`입니다. `any`가 되지 않습니다. 생성된 소스를 사용하기 전에 진단을 확인하세요.

Native parsed JSON root는 `unknown`을 사용합니다. 선택한 profile이 더 좁은 root
형태를 증명하면 예외입니다. Scalar mapping은 array, range, composite, object,
`sql_variant`, vector, 기타 container를 재귀적으로 인증하지 않습니다. 중첩
애플리케이션 타입을 생성하기 전에 그 container에 대한 증거가 필요합니다.

열 이름은 정확한 데이터베이스 키로 남습니다. 필요하면 인용된 TypeScript 속성이 됩니다. namespace 증거와 안정적인 identity 접미사가 충돌을 막습니다. 결정적인 출력은 메타데이터 캡처 타임스탬프나 객체 삽입 순서에 의존하지 않습니다.
