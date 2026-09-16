# 트랜잭션과 savepoint

> 하나의 물리적 연결을 고정하고 트랜잭션 범위를 명시적으로 만듭니다.

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

읽기 전용 query에는 `readOnly: true`를 사용하고 쓰기 문 없이 별도의
transaction을 만드세요.

```ts
// canonical-example: read-only-query
await db.tx({ readOnly: true }, async (tx) => {
  const accounts = await tx.all(sql.rows`
    SELECT id, active FROM accounts WHERE id = ${accountId}
  `);
  console.log(accounts);
});
```

callback 안의 모든 `tx.*` 작업은 commit 또는 rollback까지 하나의 물리적
연결을 재사용합니다. transaction 안에서는 바깥 `db`가 아니라 callback
handle을 사용하세요. callback이 반환되면 handle은 닫힙니다.

중첩 `tx` 호출은 executor가 `transaction.savepoint`를 advertise할 때
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

Savepoint가 활성화된 동안에는 가장 안쪽 handle을 사용합니다. Parent나
sibling 사용은 runtime scope 오류로 거부됩니다. Savepoint를 열기 전에
transaction stream을 닫아야 하며, 겹치는 pinned 작업을 다른 연결로 옮기지
않고 실패합니다.

## Session과 물리 lease

`db.session(async (session) => ...)`은 전체 callback 동안 하나의 provider
lease를 고정합니다. 중첩 session은 같은 lease를 재사용하고 session 안의
`session.tx(...)`도 재획득하지 않습니다. 바깥 root database로 session을 빠져나갈
수 없습니다. Provider는 물리 연결이 아니라 lease source입니다. Pooled root
작업은 lease를 얻고 실행하고 반환한 뒤 materialized 결과를 매핑합니다.
Stream은 cursor/request 정리까지 lease를 유지합니다. Session primitive가
없으면 `BRAID_SESSION_UNSUPPORTED`로 거부합니다.

`session.tx(...)`를 호출하기 전에 session의 stream을 닫으세요. 겹치는
transaction은 stream을 기다리거나 다른 lease를 얻지 않고 `BEGIN` 전에
`BRAID_STREAM_SCOPE`로 거부됩니다. `tx.session(...)`으로 감싸더라도
가장 안쪽 transaction/savepoint handle만 사용할 수 있다는 규칙은 유지됩니다.

## Transaction option

Portable option은 의도적으로 고정되어 있습니다.

```ts
type TransactionIsolation =
  | "read-uncommitted"
  | "read-committed"
  | "repeatable-read"
  | "serializable";

interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

Runtime은 이 literal을 adapter가 소유한 transaction control로만 매핑합니다.
임의 JavaScript text를 `BEGIN`/`SET TRANSACTION`에 보간하지 않고, 생략된
option을 조용히 바꾸지도 않습니다. 생략하면 실제 connection/session
기본값을 보존합니다. Malformed JavaScript 값은 lease 획득 전에
`TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패합니다. 유효하지만 지원하지
않는 isolation 또는 access mode는 feature가
`transaction.isolation.<level>` 또는 `transaction.read-only`인
`UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`로 실패합니다.

Transaction이 없으면 `BRAID_TX_UNSUPPORTED`를 사용합니다. 중첩 명시 option은
`{}`도 포함하여 `BRAID_TX_OPTIONS_NESTED`로 거부하며 활성 transaction을
바꿀 수 없습니다. Adapter는 capability evidence가 허용할 때만 PostgreSQL의
`read-uncommitted`를 문서화된 `read-committed` 동작으로 매핑할 수 있습니다.
SQLite, D1 및 다른 driver는 실제 transport가 honor하는 조합만 노출합니다.

libSQL adapter는 ordinary client call에 `BEGIN`/`COMMIT`을 보내는 대신
interactive `Transaction` handle을 통해 transaction 연속성을 보존합니다.
`readOnly: true`는 libSQL의 문서화된 read mode로 매핑하지만 portable
isolation literal은 libSQL transaction mode와 자동으로 동등하지 않으므로
거부합니다. 일반 libSQL 호출은 pinned session을 보장하지 않으므로
`session.pinned`는 unsupported입니다.

## Batch와 bulk

`batch`는 atomic하지 않습니다. 앞선 statement와 mapping 실패 시 뒤의
statement도 이미 실행되었을 수 있으므로 atomicity가 필요하면
`db.tx(...)`로 감싸세요.

`batch([])`는 lease를 얻거나 반환하지 않고 `[]`를 반환하며 query lifecycle
이벤트도 발생시키지 않습니다. 실행 option 검사는 유지되므로 이미 abort된
signal은 no-op 결과를 반환하기 전에 원래 reason으로 거부됩니다.

`db.bulk(inputs, factory)`는 command-only 동종 DML이며 transaction이 아닙니다.
Root bulk는 하나의 lease를 사용하지만 portable atomicity/auto-chunking 약속이
없습니다. 모든 항목을 같은 transaction으로 묶으려면 callback 안에서
`tx.bulk(inputs, factory)`를 사용하세요. Driver는 실제 mode
(`native-bulk`, `pipeline`, `prepared-loop`, `remote-batch`)를 보고합니다.

Transaction control이 불확실하게 실패하면 물리 resource를 poison합니다.
Pool cleanup은 이를 폐기하고 direct resource는 이후 SQLBraid 작업을
거부합니다. Abandoned live stream은 활성 cursor 위에서 commit하지 않고
rollback합니다.
