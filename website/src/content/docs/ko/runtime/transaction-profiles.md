---
title: Transaction option capability
description: 고정된 transaction option, 물리 scope와 driver 증거를 설명합니다.
---

이 페이지는 현재 option 경계를 설명하며 speculative transaction-profile API가
아닙니다. SQLBraid는 dialect, driver, execution runtime, host를 별도 축으로
유지합니다.

1. **Dialect** — SQL 표면, lexical profile, quoting, database semantics
2. **Driver** — protocol bridge, placeholder, materialization, cleanup
3. **Runtime** — lease 소유, session 고정, transaction/savepoint scope
4. **Host** — Node, Bun, Deno, browser, Worker evidence

고정된 public option을 사용합니다.

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.execute(query);
});
```

`isolation`은 `read-uncommitted`, `read-committed`, `repeatable-read`,
`serializable`만 허용하며 `readOnly`는 별도 boolean입니다. Runtime은 lease를
획득하기 전에 JavaScript 값을 검증합니다. Malformed 값은 `TypeError` /
`BRAID_TX_OPTIONS_INVALID`이고, 선택한 adapter가 advertise하지 않은 유효한
option은 `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`이며 feature는
`transaction.isolation.<level>` 또는 `transaction.read-only`입니다. `{}`를
포함한 중첩 명시 option은 `BRAID_TX_OPTIONS_NESTED`입니다. Transaction이 없는
driver는 `BRAID_TX_UNSUPPORTED`를 사용합니다.

Option을 생략하면 실제 물리 connection/session 기본값을 보존합니다. Runtime은
고정 literal을 adapter 소유 control SQL로 매핑하며 arbitrary JavaScript text를
보간하지 않습니다. Dialect 이름이 isolation capability를 의미하지 않습니다.
`db.session(callback)`은 provider lease 하나를 고정하고 session 안의
transaction 작업은 재획득하지 않고 이를 재사용합니다.

Provider/lease identity, savepoint, 불확실한 cleanup은 execution runtime의
계약입니다. [트랜잭션](/SQLBraid/runtime/transactions/), [풀](/SQLBraid/runtime/direct-pools/), [지원 증거](/SQLBraid/reference/support/)를 참고하세요.
