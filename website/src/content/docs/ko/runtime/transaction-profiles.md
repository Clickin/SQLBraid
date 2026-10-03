---
title: 트랜잭션 옵션 기능
description: 고정된 트랜잭션 옵션, 물리 범위, 드라이버 근거를 설명합니다.
---

이 페이지는 현재 옵션의 경계를 설명합니다. 앞으로 생길지 모르는 트랜잭션 프로필 API에 대한 설명이 아닙니다. SQLBraid는 방언, 드라이버, 실행 런타임, 호스트를 서로 독립된 축으로 다룹니다.

1. **방언**: SQL 문법, 어휘 규칙, 따옴표 처리, 데이터베이스 의미
2. **드라이버**: 프로토콜 연결, 플레이스홀더, 변환, 정리
3. **런타임**: 리스 소유권, 세션 고정, 트랜잭션·세이브포인트 범위
4. **호스트**: Node, Bun, Deno, 브라우저, Worker 근거

고정된 공개 옵션을 쓰세요.

```ts
await db.tx({ isolation: "serializable", readOnly: true }, async (tx) => {
  await tx.execute(query);
});
```

`isolation`은 `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable`만 받습니다. `readOnly`는 별도의 불리언입니다. 런타임은 리스를 획득하기 전에 JavaScript 값을 검증합니다.

- 형식이 잘못된 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`입니다.
- 올바르지만 선택한 어댑터가 지원한다고 밝히지 않은 옵션은 `UnsupportedFeatureError` / `BRAID_TX_OPTION_UNSUPPORTED`이며, feature는 `transaction.isolation.<level>`이나 `transaction.read-only`입니다.
- `{}`를 포함해 중첩 트랜잭션에 명시한 옵션은 `BRAID_TX_OPTIONS_NESTED`입니다.
- 트랜잭션이 없는 드라이버는 `BRAID_TX_UNSUPPORTED`를 씁니다.

옵션을 생략하면 물리 커넥션이나 세션의 실제 기본값이 유지됩니다. 런타임은 정해진 리터럴을 어댑터가 맡는 제어 SQL로 매핑하며, 임의의 JavaScript 텍스트를 끼워 넣지 않습니다. 방언 이름만으로 격리 수준 기능이 있다고 보지 않습니다. `db.session(callback)`은 프로바이더 리스 하나를 고정합니다. 세션 안의 트랜잭션 작업은 같은 리스를 쓰며 다시 획득하지 않습니다.

### Bun.SQL MySQL/MariaDB의 접근 모드

`readOnly: true`와 `readOnly: false`는 둘 다 지원하지 않습니다. I/O 전에 `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다.

네이티브 Bun 1.3.14는 롤백과 명시적인 읽기·쓰기 begin 뒤에도, 실패한 읽기 전용 문장의 형태를 같은 커넥션에 남겨 둘 수 있습니다. SQLBraid는 그 커넥션을 안전하게 복구할 수 없습니다. 트랜잭션 SQL을 바꿀 수도, 고정된 세션 안에서 커넥션을 바꿀 수도 없습니다. 그래서 오염된 예약 커넥션은 폐기합니다.

네이티브 errno 1792 / SQLSTATE 25006이 나오면, 해당 예약 커넥션은 소유 범위가 정상적으로 커밋이나 롤백된 뒤 폐기 대상으로 표시됩니다. 그 범위 안에서 다른 커넥션으로 바꾸지는 않습니다. 환경 조건은 `bun-sql.mysql-read-only-cache`입니다.

`readOnly`를 생략하면 네이티브 세션 기본값이 유지되며, 읽기·쓰기 모드를 강제하지 않습니다. 트랜잭션 격리 수준과 숫자·표현 방식 프로필 옵션은 바뀌지 않습니다. 이 제한은 Bun.SQL의 MySQL·MariaDB 전송에만 적용됩니다. Bun.SQL PostgreSQL이나 다른 MySQL·MariaDB 드라이버에는 적용되지 않습니다.

프로바이더·리스 식별, 세이브포인트, 불확실한 정리는 실행 런타임의 영역입니다. [트랜잭션](/SQLBraid/runtime/transactions/), [풀](/SQLBraid/runtime/direct-pools/), [지원 근거](/SQLBraid/reference/support/)를 보세요.
