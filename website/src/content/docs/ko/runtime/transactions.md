---
title: 트랜잭션과 세이브포인트
description: 물리 커넥션 하나를 고정하고 트랜잭션 범위를 명시합니다.
---

`db.tx`는 커넥션을 고정하는 경계입니다.

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

읽기 전용 쿼리에는 `readOnly: true`를 준 별도의 트랜잭션을 쓰세요. 행을 만드는 문장만 쓰세요.

```ts
// canonical-example: read-only-query
await db.tx({ readOnly: true }, async (tx) => {
  const accounts = await tx.all(sql.rows`
    SELECT id, active FROM accounts WHERE id = ${accountId}
  `);
  console.log(accounts);
});
```

콜백 안의 모든 `tx.*` 작업은 커밋이나 롤백까지 같은 물리 커넥션을 씁니다. 트랜잭션 안의 작업에는 바깥쪽 `db`가 아니라 콜백 핸들을 쓰세요. 콜백 핸들은 콜백이 반환되면 닫힙니다.

런타임은 콜백의 async context로 바깥쪽 `db` 사용을 거부합니다. `db.tx`보다 먼저 시작한 큐, 타이머, 워커에서 실행되는 작업에는 그 context가 없습니다. 예를 들어 콜백이 이런 큐에 넣은 함수는 트랜잭션 밖의 다른 커넥션에서 실행되고, 런타임은 이를 거부하지 않습니다. 커넥션이 하나인 풀이나 직접 실행기에서는 그 작업이 트랜잭션을 기다리다 교착 상태가 될 수 있습니다. 이런 작업에는 콜백 핸들을 넘기거나, 콜백이 반환되기 전에 작업을 끝내세요.

실행기가 `transaction.savepoint`를 지원한다고 밝히면, 중첩된 `tx` 호출은 세이브포인트를 씁니다.

```ts
await db.tx(async (tx) => {
  await tx.execute(first);
  await tx.tx(async (nested) => {
    await nested.execute(second);
    // Throwing here rolls back this savepoint.
  });
});
```

세이브포인트가 활성인 동안에는 가장 안쪽 핸들을 쓰세요. 상위나 형제 핸들을 쓰면 런타임 범위 오류로 거부됩니다. 세이브포인트를 열기 전에 트랜잭션 스트림을 닫으세요. 고정된 커넥션에서 겹치는 작업은 실패하며, 다른 커넥션으로 옮겨 가지 않습니다.

## 세션과 물리 리스

`db.session(async (session) => ...)`은 콜백 전체 동안 프로바이더 리스 하나를 고정합니다.

- 중첩 세션은 같은 리스를 씁니다.
- 세션 안의 `session.tx(...)`는 다시 획득하지 않고 그 리스를 씁니다.
- 바깥쪽 루트 데이터베이스로 세션을 빠져나갈 수 없습니다.
- 프로바이더는 리스를 내주는 곳이지 물리 커넥션이 아닙니다. 풀을 쓰는 루트 작업은 획득, 실행, 반환 후 메모리로 읽은 결과를 매핑합니다.
- 스트림은 커서나 요청을 정리할 때까지 리스를 붙잡고 있습니다.
- 세션 기능이 없으면 `BRAID_SESSION_UNSUPPORTED`로 거부됩니다.

SQLBraid는 풀 리스를 반환할 때 커넥션의 세션 상태를 초기화하지 않습니다. 세션 상태에는 `db.tx` 밖에서 실행한 `BEGIN`으로 열린 트랜잭션, `SET ROLE`, `SET search_path`, 세션 변수, 임시 테이블이 있습니다. 그 커넥션을 다음에 받은 작업은 그 상태를 그대로 봅니다. 트랜잭션에는 `db.tx`를 쓰세요. 다른 세션 상태는 세션 콜백이나 작업이 끝나기 전에 되돌려서 다른 요청이나 테넌트에 남지 않게 하세요.

`session.tx(...)`를 호출하기 전에 세션의 스트림을 닫으세요. 겹치는 트랜잭션은 `BEGIN` 전에 `BRAID_STREAM_SCOPE`로 거부됩니다. 스트림이 끝나기를 기다리거나 다른 리스를 획득하지 않습니다. 트랜잭션을 `tx.session(...)`으로 감싸도 가장 안쪽 트랜잭션·세이브포인트 범위는 그대로입니다.

## 트랜잭션 옵션

어디서나 쓸 수 있는 옵션은 일부러 정해 두었습니다.

```ts
type TransactionIsolation = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";

interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
}
```

런타임은 이 리터럴을 어댑터가 맡는 트랜잭션 제어로 매핑합니다.

- 임의의 JavaScript 텍스트를 `BEGIN`이나 `SET TRANSACTION`에 끼워 넣지 않습니다.
- 생략한 옵션을 몰래 바꾸지 않습니다. 생략하면 커넥션이나 세션의 실제 기본값이 유지됩니다.
- 형식이 잘못된 JavaScript 값은 리스 획득 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 거부됩니다.
- 올바르지만 지원하지 않는 격리 수준이나 접근 모드는 `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`로 거부됩니다. feature는 `transaction.isolation.<level>`이나 `transaction.read-only`입니다.

트랜잭션을 쓸 수 없으면 코드는 `BRAID_TX_UNSUPPORTED`입니다. `{}`를 포함해 중첩 트랜잭션에 명시한 옵션은 `BRAID_TX_OPTIONS_NESTED`로 거부되며, 활성 트랜잭션을 바꿀 수 없습니다. 어댑터는 기능 근거가 그렇게 말할 때만 PostgreSQL `read-uncommitted`를 문서화된 `read-committed` 동작으로 매핑할 수 있습니다. SQLite, D1 등 다른 드라이버는 전송 방식이 실제로 지키는 조합만 제공합니다.

Bun.SQL MySQL과 MariaDB는 명시적인 `readOnly` 값을 둘 다 I/O 전에 `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다. 옵션을 생략하면 네이티브 세션 기본값이 유지됩니다. Bun.SQL PostgreSQL에는 이 제한이 없습니다. Bun 1.3.14의 네이티브 커넥션 오염 문제는 [트랜잭션 옵션 기능](/SQLBraid/runtime/transaction-profiles/)을 보세요.

libSQL 어댑터는 대화형 `Transaction` 핸들로 트랜잭션 연속성을 유지합니다. 일반 클라이언트 호출로 `BEGIN`/`COMMIT`을 보내지 않습니다. `readOnly: true`는 libSQL의 문서화된 읽기 모드로 매핑됩니다. libSQL 트랜잭션 모드가 자동으로 대응하지 않기 때문에 공통 격리 수준 리터럴은 거부합니다. 일반 libSQL 호출은 세션 고정을 보장하지 않으므로 `session.pinned`는 계속 미지원입니다.

## 배치와 벌크

`batch`는 원자적이지 않습니다. 앞의 문장이 이미 실행되었을 수 있습니다. 매핑이 실패하면 뒤의 문장도 이미 실행되었을 수 있습니다. 원자성이 중요하면 배치를 `db.tx(...)`로 감싸세요.

`batch([])`는 `[]`를 반환합니다. 리스를 획득하거나 반환하지 않고, 쿼리 수명 주기 이벤트도 내지 않습니다. 실행 옵션 검사는 그대로 적용됩니다. 이미 중단된 시그널은 빈 결과를 반환하기 전에 원래 reason으로 reject됩니다.

`db.bulk(inputs, factory)`는 명령 전용의 같은 형태 DML이며, 트랜잭션이 아닙니다. 루트 벌크는 리스 하나를 쓰지만 원자성이나 자동 분할에 대한 공통 보장은 없습니다. 모든 항목이 트랜잭션을 공유해야 한다면 콜백 안에서 `tx.bulk(inputs, factory)`를 쓰세요. 드라이버는 실제 실행 방식(`native-bulk`, `pipeline`, `prepared-loop`, `remote-batch`)을 보고합니다.

트랜잭션 제어가 불확실하게 실패하면 물리 리소스를 사용 불가로 표시합니다. 풀 정리 과정에서 그 리소스는 폐기됩니다. 직접 연결 리소스는 이후의 모든 SQLBraid 작업을 거부합니다. 버려진 활성 스트림은 롤백됩니다. 활성 커서가 있는 상태에서 커밋하지 않습니다.
