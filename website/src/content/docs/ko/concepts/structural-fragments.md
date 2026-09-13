---
title: 구조적 SQL 조각
description: 식별자, 목록, 조인, 신뢰된 raw SQL을 API에서 명시적으로 드러냅니다.
---

보간이 값을 공급하는 것이 아니라 SQL 구조를 바꿀 때는 구조적 헬퍼를 사용하세요.

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

- `sql.ident("schema.table")`은 각 식별자 부분을 인용합니다.
- `sql.fragment`는 내부에 일반 바인드가 있는 dialect 결합 조각을 만듭니다.
- `sql.list(values)`는 값마다 하나의 바인드를 내보내고 빈 배열을 거부합니다.
- `sql.join(fragments, separator)`는 조각만 결합하며 일반 값은 거부합니다.
- `sql.raw(text)`는 신뢰된 SQL 텍스트를 인용 없이 내보냅니다.
- `sql.empty`는 비어 있는 dialect 결합 조각입니다.

조각에는 조각을 만든 dialect가 기록됩니다. PostgreSQL 조각을 MySQL 또는 SQLite 태그와 결합하면 `BRAID_DIALECT`가 발생합니다.

안전한 헬퍼는 사용자가 고른 값을 `sql.ident` 또는 `sql.raw`에 전달하기 전에 제한할 수 있습니다.

```ts
const columns = { name: sql.ident("name"), created: sql.ident("created_at") } as const;
const order = columns[sortKey as keyof typeof columns] ?? columns.name;
```

SQLBraid가 임의 SQL 텍스트가 신뢰되었음을 증명할 수 없기 때문에 `sql.raw`는 의도적으로 명시적인 상태로 남아 있습니다.
