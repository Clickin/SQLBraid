---
title: 동적 @braid 지시어
description: 조건부 SQL을 문장 바로 옆에 두고, 지연 평가를 유지합니다.
---

v1 지시어는 `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`입니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

- `where`는 하위 항목이 SQL을 출력할 때만 `WHERE`를 붙이고, 맨 앞의 `AND`나 `OR`를 지웁니다.
- `set`은 UPDATE의 대입 목록에 같은 처리를 합니다. 남은 대입이 없으면 `BRAID_EMPTY_SET`을 던집니다.
- `trim`은 명시적인 속성 `prefix`, `prefixOverrides`, `suffix`, `suffixOverrides`를 받습니다.

## `set`과 `trim`

`set`은 UPDATE의 대입 목록을 만듭니다. 각 대입 뒤에 쉼표를 붙여 쓰면, `set`이 마지막 쉼표를 지웁니다.

```ts
const update = sql.command`
  UPDATE users
  /*@braid set*/
    /*@braid if ${newName != null}*/ name = ${newName}, /*@braid end*/
    /*@braid if ${newAge != null}*/ age = ${newAge}, /*@braid end*/
  /*@braid end*/
  WHERE id = ${userId}
`;
// newName = "Ada", newAge = null  ->  UPDATE users SET name = ? WHERE id = ?
// newName = null,  newAge = null  ->  데이터베이스를 호출하기 전에 BRAID_EMPTY_SET을 던집니다
```

`trim`은 일반 형태입니다. `where`와 `set`은 속성이 고정된 `trim`입니다. 괄호로 묶은 목록처럼 다른 경우에는 `trim`을 씁니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE role IN
  /*@braid trim prefix="(" suffix=")" suffixOverrides=","*/
    /*@braid if ${roleA != null}*/ ${roleA}, /*@braid end*/
    /*@braid if ${roleB != null}*/ ${roleB}, /*@braid end*/
  /*@braid end*/
`;
// roleA = "x", roleB = "y"   ->  ... WHERE role IN (?, ?)
// roleA = "x", roleB = null  ->  ... WHERE role IN (?)
```

속성 규칙은 다음과 같습니다.

- `prefix`와 `suffix`는 쓴 그대로 붙습니다. 공백은 직접 넣어야 합니다. 예: `prefix="WHERE "`. 공백이 없으면 결과가 `WHEREid = ?`가 됩니다.
- `prefixOverrides`와 `suffixOverrides`는 제거할 토큰 목록이고 `|`로 구분합니다. 예: `prefixOverrides="AND |OR "`. 대소문자를 구분하지 않습니다. 내용의 첫 토큰과 마지막 토큰만 검사합니다.
- 내용이 비어 있으면 `trim`은 아무것도 출력하지 않습니다. `prefix`나 `suffix`도 붙이지 않습니다. 위 목록 예제에서 두 역할이 모두 `null`이면 SQL이 `WHERE role IN`이 되어 데이터베이스가 거부합니다. 이 경우는 바깥 `if`로 막으세요.

## 분기는 지연 평가됩니다

**이 보장은 SQLBraid 컴파일러로 변환했을 때만 성립합니다.** 일반 JavaScript, `tsc`, 런타임 태그 호출은 태그를 호출하기 전에 모든 `${...}`를 평가합니다. 분기를 지연 평가하려면 다음 순서를 따르세요.

1. `@sqlbraid/cli`를 개발 의존성으로, `@sqlbraid/template`을 의존성으로 설치합니다. 생성된 코드는 `@sqlbraid/template`에서 헬퍼를 import합니다.
2. `pnpm exec sqlbraid build --file src/query.ts --out-file build/query.js`로 조건부 소스를 빌드합니다.
3. 생성된 JavaScript를 실행합니다.

변환 후에는 조건부 보간이 해당 분기가 활성일 때만 평가됩니다. 비용이 크거나, 상태를 바꾸거나, 현재 요청에서는 유효하지 않은 값을 분기에서 읽을 때 중요합니다.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid if ${includePrivate}*/
    /*@braid if ${loadPrivatePolicy()}*/
      WHERE visibility = 'private'
    /*@braid end*/
  /*@braid end*/
`;
```

컴파일러는 조건부 템플릿을 명시적인 값 캡처 문으로 변환합니다. `includePrivate`가 false이면 `loadPrivatePolicy()`는 평가되지 않습니다. 조건부 식 문맥의 최상위에 `await`나 `yield`가 있으면 컴파일러는 그 템플릿을 변환할 수 없습니다. 이때는 평가 순서를 바꾸지 않고 `BRAID_ASYNC_CONTEXT`를 보고합니다.

## 컴파일러가 하는 일

컴파일러는 SQL 분기를 펼치지 **않습니다.** 조건 조합마다 SQL 문자열을 미리 만들지 않고, 빌드 시점에 조건을 실행하지도 않습니다. SQL 텍스트와 바인딩 값은 언제나 런타임에, 그 호출의 값으로 만듭니다.

컴파일러가 바꾸는 것은 **각 `${...}` 표현식을 언제 평가하는가**뿐입니다. 일반 JavaScript에서는 태그 함수를 호출하기 전에 모든 `${...}`가 실행됩니다. 변환 후에는 표현식이 속한 분기가 활성일 때만, 그리고 한 번만 실행됩니다. 위 쿼리의 변환 결과를 단순화하면 다음과 같습니다.

<!-- doc-snippet: skip -->

```js
sql.rows(strings, (read) => {
  if (read(0, () => includePrivate)) {
    // 활성 분기 안에서만:
    if (read(1, () => loadPrivatePolicy())) {
      /* ... */
    }
  }
});
```

런타임은 지시어와 평가된 값으로 SQL과 파라미터 목록을 만듭니다.

| 컴파일러가 하는 일                                          | 컴파일러가 하지 않는 일                   |
| ----------------------------------------------------------- | ----------------------------------------- |
| 비활성 분기의 `${...}`를 건너뛰고, 각 표현식을 한 번만 평가 | 빌드 중에 SQL 변형을 만들거나 조건을 실행 |
| 평가 순서, 렉시컬 `this`, 소스맵 유지                       | 분기 안의 SQL을 파싱하거나 검사           |
| 쿼리에 묶인 Standard Schema 매퍼의 타입 유지                | TypeScript나 JSX 변환(번들러가 담당)      |
| 변환할 수 없으면 `BRAID_ASYNC_CONTEXT` 보고                 | 타입 검사(`sqlbraid check`를 사용)        |

컴파일러가 없어도 SQL 결과는 같습니다. JavaScript 표현식의 평가 시점만 다릅니다. 비활성 분기의 표현식이 가볍고 안전하다면 컴파일러는 필요 없습니다.

## choose 분기

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/ ORDER BY name
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC
    /*@braid otherwise*/ ORDER BY id
  /*@braid end*/
`;
```

참인 첫 번째 `when`만 렌더링됩니다. SQLBraid는 분기 안의 데이터베이스별 SQL을 파싱하거나 의미를 검증하지 않습니다.

`sql.list([])`는 `BRAID_EMPTY_LIST`로 실패합니다. 빈 목록 처리는 `if`, `choose`, 명시적인 조기 반환 같은 분기를 직접 작성하세요. SQLBraid는 빈 목록을 `IN (NULL)`로 바꾸거나 임의의 대체 조건을 만들어 내지 않습니다.
