---
title: Transaction option capability
description: 고정된 transaction option, 물리 scope와 driver 증거를 설명합니다.
---

이 페이지는 현재 option 경계를 설명합니다. 추측에 기반한 transaction-profile
API가 아닙니다. SQLBraid는 dialect, driver, execution runtime, host를 별도
축으로 유지합니다.

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
`serializable`만 허용합니다. `readOnly`는 별도의 boolean입니다. Runtime은 lease
획득 전에 JavaScript 값을 검증합니다.

- 잘못된 형식의 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`입니다.
- 선택한 adapter가 advertise하지 않은 유효한 option은
  `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`입니다. feature는
  `transaction.isolation.<level>` 또는 `transaction.read-only`입니다.
- `{}`를 포함한 중첩 명시 option은 `BRAID_TX_OPTIONS_NESTED`입니다.
- Transaction이 없는 driver는 `BRAID_TX_UNSUPPORTED`를 사용합니다.

Option을 생략하면 실제 물리 connection/session 기본값이 유지됩니다. Runtime은
고정 literal을 adapter가 소유한 control SQL로 매핑합니다. 임의 JavaScript
text를 보간하지 않습니다. Dialect 이름은 isolation capability를 뜻하지
않습니다. `db.session(callback)`은 provider lease 하나를 고정합니다. session
안의 transaction 작업은 다시 획득하지 않고 같은 lease를 사용합니다.

### Bun.SQL MySQL/MariaDB access mode

`readOnly: true`와 `readOnly: false`는 모두 지원하지 않습니다. I/O 전에
`BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다.

Native Bun 1.3.14는 rollback과 명시적 read-write begin 뒤에도 같은
connection에 실패한 read-only statement shape를 유지할 수 있습니다.
SQLBraid는 그 connection을 안전하게 복구할 수 없습니다. transaction SQL을
바꾸거나 pinned session 안에서 connection을 교체할 수 없습니다. 따라서 오염된
reservation은 폐기됩니다.

Native errno 1792 / SQLSTATE 25006은 소유 scope의 정상 commit/rollback 이후
reservation을 폐기하도록 표시합니다. scope 안에서는 교체하지 않습니다.
Environment condition은 `bun-sql.mysql-read-only-cache`입니다.

`readOnly`를 생략하면 native session 기본값이 유지됩니다. read-write를 강제하지
않습니다. Transaction isolation과 numeric/representation profile option은
바뀌지 않습니다. 이 제한은 Bun.SQL MySQL/MariaDB transport에만 적용됩니다.
Bun.SQL PostgreSQL이나 다른 MySQL/MariaDB driver에는 적용되지 않습니다.

Provider/lease identity, savepoint, 불확실한 cleanup은 execution runtime의
일부입니다. [트랜잭션](/SQLBraid/runtime/transactions/), [풀](/SQLBraid/runtime/direct-pools/), [지원 증거](/SQLBraid/reference/support/)를 참고하세요.
