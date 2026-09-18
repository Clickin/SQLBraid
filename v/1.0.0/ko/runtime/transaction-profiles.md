# Transaction option capability

> 고정된 transaction option, 물리 scope와 driver 증거를 설명합니다.

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

### Bun.SQL MySQL/MariaDB access mode

`readOnly: true`와 `readOnly: false`는 모두 지원하지 않으며 I/O 전에
`BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다.
Native Bun 1.3.14는 rollback 뒤 명시적인 read-write transaction을
시작해도 같은 connection에서 실패한 read-only statement shape의 상태를
유지할 수 있습니다. Transaction SQL을 바꾸거나 pinned session 도중 connection을
교체해서 안전하게 복구할 수 없으므로 오염된 reservation은 폐기합니다.
Native errno 1792 / SQLSTATE 25006을 받으면 소유 scope의 정상적인
commit/rollback 이후 폐기하도록 표시하며 scope 안에서 교체하지 않습니다.
Environment condition은 `bun-sql.mysql-read-only-cache`입니다.

`readOnly`를 생략하면 native session 기본값을 그대로 사용하며 read-write로
강제하지 않습니다. Transaction isolation과 numeric/representation profile
option은 바뀌지 않습니다. 이 제한은 Bun.SQL MySQL/MariaDB transport에만
적용되며 Bun.SQL PostgreSQL이나 다른 MySQL/MariaDB driver에는 적용되지
않습니다.

Provider/lease identity, savepoint, 불확실한 cleanup은 execution runtime의
계약입니다. [트랜잭션](/SQLBraid/v/1.0.0/runtime/transactions.md), [풀](/SQLBraid/v/1.0.0/runtime/direct-pools.md), [지원 증거](/SQLBraid/v/1.0.0/reference/support.md)를 참고하세요.
