---
title: 트랜잭션과 savepoint
description: 하나의 물리적 연결을 고정하고 트랜잭션 범위를 명시적으로 만듭니다.
---

`db.tx`는 연결을 고정하는 경계입니다.

```ts
// canonical-example: serializable-write
await db.tx({ isolation: "serializable" }, async (tx) => {
  await tx.execute(sql.command`
    INSERT INTO audit_log (account_id) VALUES (${accountId})
  `);
  await tx.execute(sql.command`
    UPDATE accounts SET active = true WHERE id = ${accountId}
  `);
});
```

읽기 전용 query에는 `readOnly: true`를 쓰는 별도의 transaction을 만드세요.
행을 만드는 문장만 사용하세요.

```ts
// canonical-example: read-only-query
await db.tx({ readOnly: true }, async (tx) => {
  const accounts = await tx.all(sql.rows`
    SELECT id, active FROM accounts WHERE id = ${accountId}
  `);
  console.log(accounts);
});
```

callback 안의 모든 `tx.*` 작업은 commit이나 rollback까지 같은 물리적 연결을
사용합니다. transaction 안의 모든 작업에는 callback handle을 사용하세요. 바깥
`db`를 사용하지 마세요. callback이 반환되면 handle은 닫힙니다.

executor가 `transaction.savepoint`를 advertise하면 중첩 `tx` 호출은
savepoint를 사용합니다.

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // 여기서 throw하면 이 savepoint를 rollback합니다.
  });
});
```

Savepoint가 활성 상태인 동안에는 가장 안쪽 handle을 사용하세요. Parent나
sibling handle을 사용하면 runtime scope 오류로 거부됩니다. Savepoint를 열기
전에 transaction stream을 닫으세요. 겹치는 pinned 작업은 실패합니다. 다른
연결로 옮겨지지 않습니다.

## Session과 물리 lease

`db.session(async (session) => ...)`은 callback 전체 동안 provider lease 하나를
고정합니다.

- 중첩 session은 같은 lease를 사용합니다.
- session 안의 `session.tx(...)`는 다시 획득하지 않고 그 lease를 사용합니다.
- 바깥 root database로 session을 빠져나갈 수 없습니다.
- Provider는 lease의 공급원입니다. 물리 연결이 아닙니다. Pooled root 작업은
  lease를 얻고, 실행하고, 반환한 뒤 materialized 결과를 매핑합니다.
- Stream은 cursor/request 정리까지 lease를 유지합니다.
- Session primitive가 없으면 `BRAID_SESSION_UNSUPPORTED`로 거부합니다.

`session.tx(...)`를 호출하기 전에 session의 stream을 닫으세요. 겹치는
transaction은 `BEGIN` 전에 `BRAID_STREAM_SCOPE`로 거부됩니다. stream을 기다리지
않습니다. 다른 lease를 얻지 않습니다. transaction을 `tx.session(...)`으로
감싸도 가장 안쪽 transaction/savepoint scope는 바뀌지 않습니다.

## Transaction option

Portable option은 고정되어 있습니다. 이것은 의도한 설계입니다.

```ts
type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

Runtime은 이 literal을 adapter가 소유한 transaction control로 매핑합니다.

- 임의 JavaScript text를 `BEGIN`/`SET TRANSACTION`에 보간하지 않습니다.
- 생략된 option을 조용히 바꾸지 않습니다. 생략된 option은 실제
  connection/session 기본값을 유지합니다.
- 잘못된 형식의 JavaScript 값은 lease 획득 전에 `TypeError` /
  `BRAID_TX_OPTIONS_INVALID`로 실패합니다.
- 유효하지만 지원하지 않는 isolation이나 access mode는
  `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`로 실패합니다.
  feature는 `transaction.isolation.<level>` 또는 `transaction.read-only`입니다.

Transaction이 없으면 `BRAID_TX_UNSUPPORTED`를 사용합니다. `{}`를 포함한 중첩
명시 option은 `BRAID_TX_OPTIONS_NESTED`로 거부됩니다. 활성 transaction을 바꿀
수 없습니다. Adapter는 capability 증거가 허용할 때만 PostgreSQL의
`read-uncommitted`를 문서화된 `read-committed` 동작으로 매핑할 수 있습니다.
SQLite, D1, 다른 driver는 실제 transport가 따르는 조합만 노출합니다.

Bun.SQL MySQL/MariaDB는 명시적인 `readOnly`의 두 boolean 값을 모두 I/O 전에
`BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다. option을
생략하면 native session 기본값이 유지됩니다. 이 제한은 Bun.SQL PostgreSQL에
적용되지 않습니다. Native Bun 1.3.14의 connection 오염 경계는
[transaction option capability](/SQLBraid/runtime/transaction-profiles/)를 참고하세요.

libSQL adapter는 interactive `Transaction` handle로 transaction 연속성을
유지합니다. 일반 client call에 `BEGIN`/`COMMIT`을 보내지 않습니다.
`readOnly: true`는 libSQL의 문서화된 read mode로 매핑됩니다. portable
isolation literal은 거부됩니다. libSQL transaction mode와 자동으로 같지 않기
때문입니다. 일반 libSQL 호출은 pinned session을 보장하지 않습니다. 따라서
`session.pinned`는 unsupported입니다.

## Batch와 bulk

`batch`는 atomic하지 않습니다. 앞선 statement는 이미 실행되었을 수 있습니다.
mapping이 실패하면 뒤의 statement도 이미 실행되었을 수 있습니다. atomicity가
중요하면 `db.tx(...)`로 감싸세요.

`batch([])`는 `[]`를 반환합니다. lease를 얻거나 반환하지 않습니다. query
lifecycle 이벤트도 내보내지 않습니다. 실행 option 검사는 계속 적용됩니다: 이미
abort된 signal은 no-op 결과 전에 원래 reason으로 거부됩니다.

`db.bulk(inputs, factory)`는 command 전용 동종 DML입니다. transaction이
아닙니다. Root bulk는 lease 하나를 사용하지만 portable atomicity나 자동
chunking 약속이 없습니다. 모든 항목이 transaction을 공유해야 하면 callback
안에서 `tx.bulk(inputs, factory)`를 사용하세요. Driver는 실제 mode를
보고합니다: `native-bulk`, `pipeline`, `prepared-loop`, `remote-batch`.

Transaction control이 불확실하게 실패하면 물리 resource가 poison됩니다. Pool
cleanup은 그 resource를 폐기합니다. direct resource는 이후 모든 SQLBraid 작업을
거부합니다. 버려진 live stream은 rollback합니다. 활성 cursor 위에서 commit하지
않습니다.
