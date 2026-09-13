---
title: 스트리밍
description: SQLBraid가 물리적 lease를 소유하는 동안 버퍼링 없이 행을 순회합니다.
---

행 쿼리에는 `db.stream`을 사용하세요.

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

행은 하나씩 매핑됩니다. 풀 루트 stream은 순회가 완료되거나 중단되거나 abort되거나 실패할 때까지 lease를 유지합니다. 직접 stream은 자체 물리 리소스에 다시 진입할 수 없으며 SQLBraid는 deadlock 대신 `BRAID_STREAM_SCOPE`를 발생시킵니다.

consumer가 취소할 수 있다면 `AbortSignal`을 전달하세요.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

트랜잭션 콜백이 반환되기 전에 stream을 닫거나 모두 소비하세요. 트랜잭션 stream은 고정된 연결에서 겹치는 작업을 금지하며, 버려진 iterator는 rollback을 일으킵니다. 스트리밍 프로토콜이 없는 어댑터는 `BRAID_STREAM_UNSUPPORTED`를 발생시킵니다. SQLite 어댑터는 네이티브 문 순회를 사용합니다.
