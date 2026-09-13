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

팩토리는 실행할 때마다 평가되고 한 번 렌더링됩니다. SQLBraid는 첫 논리
shape(결과 종류, 정규화된 `segments`, 순서가 있는 힌트 시그니처)를 shape
lock으로 기록합니다. 이후 논리 shape가 바뀌면 드라이버 I/O 전에
`BRAID_PREPARED_SHAPE`를 발생시킵니다. 값만 바꾸는 것은 shape를 바꾸지
않습니다. 물리적인 `$1`, `?`, `:1`, `@p1` 표기는 전송별 세부 사항이며 shape
identity에 포함되지 않습니다. 이름은 비어 있지 않고 고유해야 합니다
(`BRAID_PREPARED_NAME`).

Prepared 이벤트는 SQLBraid shape-lock 이름과 유효한 바인딩 계획을 observer에
노출합니다. `auto`, `simple`, `reuse` 중 유효한 정책은 드라이버가 선택하며
런타임은 범용 prepared cache를 추가하지 않습니다. 여기서 “Prepared”는
안정적인 애플리케이션 쿼리 형태를 뜻하며, 네이티브 prepared statement나
서버 측 plan을 약속하지 않습니다.
