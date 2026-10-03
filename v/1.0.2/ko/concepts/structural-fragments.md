# 구조적 SQL 조각

> 식별자, 목록, 결합, 신뢰하는 원시 SQL을 API에서 눈에 보이게 다룹니다.

보간이 값을 넣는 대신 SQL 구조를 바꾼다면 구조 헬퍼를 쓰세요.

```ts
const column = sql.ident("created_at");
const direction = sql.raw(sortDescending ? "DESC" : "ASC");
const ids = sql.list([10, 20, 30]);

const query = sql.rows<UserRow>`
  SELECT id, name FROM users
  WHERE id IN (${ids})
  ORDER BY ${column} ${direction}
`;
```

- `sql.ident("schema.table")`은 식별자의 각 부분을 따옴표로 감쌉니다.
- `sql.fragment`는 방언에 묶인 조각을 만듭니다. 조각 안에 일반 바인딩을 넣을 수 있습니다.
- `sql.list(values)`는 값마다 바인딩을 하나씩 만듭니다. 빈 배열은 거부합니다.
- `sql.join(fragments, separator)`는 조각만 결합합니다. 일반 값은 거부합니다.
- `sql.raw(text)`는 신뢰하는 SQL 텍스트를 따옴표 없이 그대로 넣습니다.
- `sql.empty`는 방언에 묶인 빈 조각입니다.

모든 조각은 자신을 만든 방언을 기억합니다. PostgreSQL 조각을 MySQL이나 SQLite 태그와 섞으면 SQLBraid가 `BRAID_DIALECT`를 던집니다.

사용자의 선택이 `sql.ident`나 `sql.raw`에 도달하기 전에, 안전한 헬퍼로 선택지를 제한할 수 있습니다.

```ts
const columns = { name: sql.ident("name"), created: sql.ident("created_at") } as const;
const order = columns[sortKey as keyof typeof columns] ?? columns.name;
```

`sql.raw`는 일부러 눈에 띄게 남겨 두었습니다. SQLBraid는 임의의 SQL 텍스트가 신뢰할 만한지 증명할 수 없습니다.
