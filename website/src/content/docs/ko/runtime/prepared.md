---
title: 준비된 쿼리
description: 네이티브 드라이버 준비를 약속하지 않고 안정적인 SQLBraid 쿼리 형태를 재사용합니다.
---

이름이 지정된 행 쿼리 팩토리를 등록하세요.

```ts
const byId = db.prepare("user-by-id", () => sql.rows<UserRow>`
  SELECT id, name FROM users WHERE id = ${userId}
`);

const user = await byId.maybeOne();
const all = await byId.all();
```

팩토리는 실행할 때마다 평가됩니다. SQLBraid는 처음 렌더링된 구조를 shape lock으로 기록합니다. 이후 실행에서 렌더링 구조가 바뀌면 `BRAID_PREPARED_SHAPE`를 발생시킵니다. 이름은 비어 있지 않아야 하고 고유해야 합니다(`BRAID_PREPARED_NAME`).

Prepared 이벤트는 관찰자에게 SQLBraid shape-lock 이름을 노출합니다. 여기서 “Prepared”는 안정적인 애플리케이션 쿼리 형태를 뜻하며, 네이티브 prepared statement나 서버 측 plan을 약속하지 않습니다.
