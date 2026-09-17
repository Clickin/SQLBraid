# 동종 bulk DML

> 드라이버 capability를 숨기지 않고 하나의 command shape에 여러 value set을 적용합니다.

`db.bulk(inputs, factory)`는 동종 DML을 위한 SQLBraid throughput primitive입니다.
서로 다른 query 목록을 실행하는 `db.batch(queries)`와 다릅니다.

```ts
const result = await db.bulk(
  accounts.map(({ id, amount }) => ({ id, amount })),
  (input) => sql.command`
    UPDATE account
    SET amount = ${input.amount}
    WHERE id = ${input.id}
  `,
);

// { inputCount, affectedRows? }
```

## 계약

- `CommandQuery`만 받습니다. Row set을 반환하지 않으며 DML
  `RETURNING`/`OUTPUT`와 결합하지 않습니다.
- 첫 번째 렌더링 문장이 하나의 logical shape를 정합니다. 이후 row는 Braid
  구조, list/cardinality, hint, bind direction을 유지해야 합니다.
- Shape/materialization 오류는 DB I/O 전에 발생합니다. `sql.out()`과
  `sql.inOut()`은 bulk parameter로 사용할 수 없습니다.
- 빈 입력은 lease를 acquire하지 않고 `{ inputCount: 0 }`을 반환합니다.
- 하나의 physical lease를 사용하고 실제 모드 `native-bulk`, `pipeline`,
  `prepared-loop`, `remote-batch` 중 하나를 보고합니다.
- Observer에는 N개의 일반 query lifecycle이 아닌 하나의 bulk 작업이
  전달됩니다. Statement metadata를 N번 복제하지 않고 item별 값과 진단 SQL을
  bulk description에서 볼 수 있습니다.

## Atomicity와 chunking

Root bulk에는 portable transaction 약속이 없고 암묵적으로 transaction으로
감싸지지 않습니다. 모든 변경을 하나의 transaction에서 실행하려면 callback을
사용하세요.

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, factory);
});
```

Portable auto-chunking 계약은 없습니다. 드라이버가 더 강한 native batch
semantics를 제공하더라도 선택한 어댑터 문서 밖에서 의존하지 마세요.

## 드라이버 모드

| 어댑터                 | 모드            | 구조적 증거 목표                                             |
| ---------------------- | --------------- | ------------------------------------------------------------ |
| PostgreSQL / `pg`      | `prepared-loop` | 순차 named 실행, client별 제한된 statement 재사용            |
| MySQL / `mysql2`       | `prepared-loop` | prepare 1회, execute N회, `unprepare()`로 close와 cache 제거 |
| MariaDB / Connector    | `native-bulk`   | `connection.batch()` 1회                                     |
| SQLite / `node:sqlite` | `prepared-loop` | prepared statement 1개 재사용                                |
| SQLite / WASM          | `prepared-loop` | OO1 statement 1개 반복 reset                                 |
| Cloudflare D1          | `remote-batch`  | `D1Database.batch()` 1회                                     |
| Oracle Thin            | `native-bulk`   | `executeMany()` 1회                                          |
| SQL Server / Tedious   | `prepared-loop` | prepare/unprepare 1회씩, execute N회                         |

각 데이터베이스 및 드라이버별 상세 프로필과 기능 조건은 [런타임 및 드라이버 지원](/SQLBraid/v/1.0.0/reference/support.md)을 참고하세요.
