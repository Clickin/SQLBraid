# 동적 @braid 지시문

> 문장 옆에 조건부 SQL을 유지하면서 지연 평가를 보존합니다.

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

`where`는 자식이 SQL을 생성할 때만 `WHERE`를 추가하고 선행 `AND` 또는 `OR`를 제거합니다. `set`도 업데이트 할당에 동일하게 동작하며 할당이 남지 않으면 `BRAID_EMPTY_SET`을 발생시킵니다. `trim`은 명시적인 `prefix`, `prefixOverrides`, `suffix`, `suffixOverrides` 속성을 받습니다.

## 분기는 지연됩니다

**이 보장은 SQLBraid 컴파일러 lowering이 필요합니다.** 일반 JavaScript, `tsc`, 런타임 태그 호출은 태그를 호출하기 전에 모든 `${...}`를 평가합니다. `@sqlbraid/cli`를 설치하고 보호된 소스를 `npx sqlbraid build --file src/query.ts --out-file build/query.js`로 빌드한 후 생성된 JavaScript를 실행하세요.

lowering 후에는 분기가 활성화될 때만 보호된 보간을 캡처합니다. 이는 현재 요청에서 비용이 크거나 상태를 변경하거나 유효하지 않을 수 있는 값을 분기에서 읽을 때 중요합니다.

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

컴파일러는 보호된 템플릿을 명시적인 캡처 문으로 lowering합니다. `includePrivate`가 false이면 `loadPrivatePolicy()`는 평가되지 않습니다. 보호된 표현식 컨텍스트에 최상위 `await` 또는 `yield`가 나타나면 보호된 템플릿을 lowering할 수 없으며, 컴파일러는 평가 순서를 바꾸는 대신 `BRAID_ASYNC_CONTEXT`를 보고합니다.

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
