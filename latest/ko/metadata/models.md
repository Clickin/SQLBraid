# Row, Insert, Update 모델

> 생성되는 선언과 보수적인 근거 규칙을 알아봅니다.

`generateModels(metadata, options)`는 순수 함수이며 오프라인으로 동작합니다. 독립된 TypeScript 소스, 모델 이름, 진단, 메타데이터와 정책의 출처, 옵션 해시를 반환합니다.

숫자 identity `id`, 필수 `email`이 있고, 생성 열이나 쓰기 불가 열에 대한 근거가 없는 테이블을 예로 들어 봅시다. 이 테이블에 대해 codegen은 다음을 출력합니다.

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

- **Row**는 TypePolicy의 `outputType`을 씁니다. 데이터베이스에서 nullable이면 `| null`이 붙습니다.
- **Insert**는 `inputType`을 씁니다. nullable 열, 기본값이 있는 열, identity 열은 선택 사항입니다. 삽입할 수 없거나 생성되는 열이라고 증명된 열은 빠집니다.
- **Update**는 `inputType`을 씁니다. 포함된 속성은 모두 선택 사항입니다. 수정할 수 없거나 생성되는 열이라고 증명된 열은 빠집니다. identity라는 이유만으로 빠지지는 않습니다.

정확한 정수·소수 출력 타입은 정규 `string`이고, 근사 이진 타입은 `number`입니다. 생성된 모델은 정확한 문자열을 몰래 `bigint`나 소수 객체로 바꾸지 않습니다.

뷰, 구체화된 뷰, 외부 릴레이션, 가상 릴레이션에는 Row 모델만 생성됩니다. 열이 있는 알 수 없는 종류의 릴레이션은 Row 모델과 경고를 받습니다. 지원하지 않거나 증명되지 않은 타입은 `any`가 아니라 `unknown`으로 남습니다. 생성된 소스를 쓰기 전에 진단을 확인하세요.

선택한 프로필이 더 좁은 형태를 증명하지 않는 한, 네이티브로 파싱된 JSON 최상위 값은 `unknown`을 씁니다. 스칼라 매핑도 배열, 범위, 복합 타입, 객체, `sql_variant`, 벡터 같은 컨테이너를 재귀적으로 보장하지 않습니다. 중첩된 애플리케이션 타입을 생성하려면 먼저 그 컨테이너에 대한 근거가 필요합니다.

열 이름은 데이터베이스 키 그대로 유지됩니다. 필요하면 따옴표로 감싼 TypeScript 속성이 됩니다. 네임스페이스 근거와 안정적인 식별 접미사가 이름 충돌을 막습니다. 결정적인 출력은 메타데이터의 수집 시각이나 객체 삽입 순서에 영향을 받지 않습니다.
