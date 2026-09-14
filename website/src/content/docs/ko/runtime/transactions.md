---
title: 트랜잭션과 savepoint
description: 하나의 물리적 연결을 고정하고 트랜잭션 범위를 명시적으로 만듭니다.
---

`db.tx`는 연결을 고정하는 경계입니다.

```ts
await db.tx(async (tx) => {
  await tx.execute(sql.command`
    INSERT INTO audit_log (account_id) VALUES (${accountId})
  `);
  await tx.execute(sql.command`
    UPDATE accounts SET active = true WHERE id = ${accountId}
  `);
});
```

콜백 안의 모든 `tx.*` 작업은 commit 또는 rollback까지 물리적 연결 하나를 재사용합니다. 트랜잭션 안의 모든 작업에는 바깥 `db`가 아니라 콜백 핸들을 사용하세요. 콜백이 반환되면 콜백 핸들은 닫힙니다.

중첩된 `tx` 호출은 executor가 지원할 때 savepoint를 사용합니다.

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // Throwing here rolls back this savepoint.
  });
});
```

savepoint가 활성화된 동안에는 가장 안쪽 핸들을 사용하세요. 부모 또는 sibling 사용은 `BRAID_TX_SCOPE`로 실패합니다. 트랜잭션 스트림은 savepoint를 열기 전에 닫아야 하며, 고정된 작업이 겹치면 다른 연결로 옮기는 대신 실패합니다.

## 격리 기본값

SQLBraid 0.1.0은 격리 옵션을 노출하지 않으며 조용히 하나를 선택하지도 않습니다. 트랜잭션은 데이터베이스/드라이버 연결에 이미 설정된 기본 격리 동작을 사용합니다. 명시적 격리 설정은 데이터베이스별입니다. PostgreSQL은 쿼리 전에 첫 번째 `tx` 작업으로 `SET TRANSACTION`을 허용하지만, MySQL은 트랜잭션이 시작되기 전에 트랜잭션 특성 설정을 요구합니다. 별도의 풀 루트 작업이 아니라 같은 소유 물리 연결 또는 해당 세션 초기화에서 설정하세요. SQLite는 이 `SET TRANSACTION` 문법을 공유하지 않습니다. 선택한 드라이버로 설정을 확인하고 dialect 이름이나 Node/Bun/Deno에서 격리를 추론하지 마세요.

Batch는 원자적이지 않습니다. 앞선 문장과, 결과 매핑이 실패하는 경우 뒤의 문장도 이미 실행되었을 수 있습니다. 원자성이 필요하면 batch를 `db.tx(...)`로 감싸세요.

`db.bulk(inputs, factory)`는 command-only 동종 DML이며 transaction의 대체물이
아닙니다. Root bulk는 하나의 physical lease를 사용하지만 portable atomicity
약속이 없고 암묵적으로 transaction으로 감싸지지 않으며 auto-chunk하지
않습니다. 모든 항목을 하나의 transaction으로 묶으려면 callback 안에서
`tx.bulk(inputs, factory)`를 사용하세요.

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, (input) => sql.command`
    UPDATE account SET amount = ${input.amount} WHERE id = ${input.id}
  `);
});
```

드라이버는 실제 bulk 모드(`native-bulk`, `pipeline`, `prepared-loop`,
`remote-batch`)를 보고하며 dialect 간 throughput 또는 transaction을
약속하지 않습니다. D1에는 현재 이 계약에 맞는 callback transaction
primitive가 없습니다.

트랜잭션 제어 실패 여부가 불확실하면 물리 리소스가 오염됩니다. 풀 정리는 해당 리소스를 폐기하며, 직접 리소스는 이후 SQLBraid 작업을 거부합니다. 활성 cursor를 commit한 채로 남기지 않도록, 방치된 live stream은 commit 대신 rollback합니다.
