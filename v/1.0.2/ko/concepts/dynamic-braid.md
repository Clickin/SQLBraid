# 동적 @braid 지시어

> 조건부 SQL을 문장 바로 옆에 두고, 지연 평가를 유지합니다.

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

## 분기는 지연 평가됩니다

**이 보장은 SQLBraid 컴파일러로 변환했을 때만 성립합니다.** 일반 JavaScript, `tsc`, 런타임 태그 호출은 태그를 호출하기 전에 모든 `${...}`를 평가합니다. 분기를 지연 평가하려면 다음 순서를 따르세요.

1. `@sqlbraid/cli`를 설치합니다.
2. `npx sqlbraid build --file src/query.ts --out-file build/query.js`로 조건부 소스를 빌드합니다.
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

## choose 분기

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

참인 첫 번째 `when`만 렌더링됩니다. SQLBraid는 분기 안의 데이터베이스별 SQL을 파싱하거나 의미를 검증하지 않습니다.

`sql.list([])`는 `BRAID_EMPTY_LIST`로 실패합니다. 빈 목록 처리는 `if`, `choose`, 명시적인 조기 반환 같은 분기를 직접 작성하세요. SQLBraid는 빈 목록을 `IN (NULL)`로 바꾸지 않으며, 다른 처리 방식을 지어내지도 않습니다.
