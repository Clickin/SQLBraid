---
title: 동적 @braid 지시문
description: 조건부 SQL을 문장 옆에 두고 지연 평가를 유지합니다.
---

v1 지시문은 `if`, `choose`, `when`, `otherwise`, `where`, `set`, `trim`입니다.

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

- `where`는 자식이 SQL을 생성할 때만 `WHERE`를 추가합니다. 앞에 오는 `AND`나 `OR`를 제거합니다.
- `set`은 업데이트 할당에 같은 동작을 합니다. 할당이 남지 않으면 `BRAID_EMPTY_SET`을 발생시킵니다.
- `trim`은 명시적인 `prefix`, `prefixOverrides`, `suffix`, `suffixOverrides` 속성을 받습니다.

## 분기는 지연됩니다

**이 보장에는 SQLBraid 컴파일러 lowering이 필요합니다.** 일반 JavaScript, `tsc`, 런타임 태그 호출은 태그를 호출하기 전에 모든 `${...}`를 평가합니다. 지연 분기를 얻으려면 다음 순서를 따르세요.

1. `@sqlbraid/cli`를 설치합니다.
2. 보호된 소스를 `npx sqlbraid build --file src/query.ts --out-file build/query.js`로 빌드합니다.
3. 생성된 JavaScript를 실행합니다.

lowering 후에는 분기가 활성 상태일 때만 보호된 보간을 캡처합니다. 분기가 비용이 크거나, 상태를 가지거나, 현재 요청에서 유효하지 않은 값을 읽을 때 이것이 중요합니다.

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

컴파일러는 보호된 템플릿을 명시적인 캡처 문으로 lowering합니다. `includePrivate`가 false이면 `loadPrivatePolicy()`는 평가되지 않습니다. 보호된 표현식 컨텍스트에 최상위 `await`나 `yield`가 있으면 컴파일러는 그 템플릿을 lowering할 수 없습니다. 이 경우 컴파일러는 `BRAID_ASYNC_CONTEXT`를 보고합니다. 평가 순서를 바꾸지 않습니다.

## Choose 분기

```ts
const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid choose*/
    /*@braid when ${sort === "name"}*/ ORDER BY name /*@braid end*/
    /*@braid when ${sort === "created"}*/ ORDER BY created_at DESC /*@braid end*/
    /*@braid otherwise*/ ORDER BY id /*@braid end*/
  /*@braid end*/
`;
```

true인 첫 번째 `when`만 렌더링됩니다. SQLBraid는 분기 내부의 데이터베이스별 SQL을 파싱하거나 의미적으로 검증하지 않습니다.

`sql.list([])`는 `BRAID_EMPTY_LIST`로 실패합니다. 빈 경우에는 직접 분기를
작성하세요: `if`, `choose`, 명시적인 early return. SQLBraid는 빈 목록을
`IN (NULL)`로 바꾸지 않습니다. 임의의 전략을 만들지 않습니다.
