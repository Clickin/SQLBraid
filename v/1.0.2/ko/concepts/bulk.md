# 같은 형태의 벌크 DML

> 명령 형태 하나를 여러 값 집합으로 실행합니다. 드라이버 기능을 감추지 않습니다.

`db.bulk(inputs, factory)`는 같은 형태의 DML을 빠르게 처리하기 위한 SQLBraid의 기본 수단입니다. 서로 다른 쿼리 목록을 실행하는 `db.batch(queries)`와는 일부러 구분했습니다.

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

## 규칙

- 벌크는 `CommandQuery` 값만 받습니다. 행 집합을 반환하지 않으며, DML의 `RETURNING`/`OUTPUT`과 함께 쓸 수 없습니다.
- 처음 렌더링한 문장이 논리적 형태를 정합니다. 이후 행은 Braid 구조, 목록 개수, 힌트, 바인딩 방향이 같아야 합니다.
- 형태 오류와 변환 오류는 데이터베이스 I/O 전에 발생합니다. `sql.out()`과 `sql.inOut()`은 벌크 파라미터로 쓸 수 없습니다.
- 입력이 비어 있으면 `{ inputCount: 0, affectedRows: 0 }`을 반환하고 리스를 획득하지 않습니다.
- 작업 전체가 물리 리스 하나를 씁니다. 드라이버는 실제 실행 방식(`native-bulk`, `pipeline`, `prepared-loop`, `remote-batch`)을 보고합니다.
- 옵저버에는 일반 쿼리 수명 주기 N개가 아니라 벌크 작업 하나로 보입니다. 각 항목의 값과 진단용 SQL은 벌크 설명에서 볼 수 있습니다. 문장 메타데이터는 N번 복사되지 않습니다.

## 원자성과 분할

루트 벌크에는 어디서나 통하는 트랜잭션 보장이 없습니다. SQLBraid는 벌크를 몰래 트랜잭션으로 감싸지 않습니다. 모든 변경이 한 트랜잭션 안에 있어야 한다면 트랜잭션 콜백을 쓰세요.

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, factory);
});
```

자동 분할에 대한 공통 규칙은 없습니다. 드라이버에 따라 네이티브 배치가 더 강한 보장을 줄 수도 있습니다. 하지만 선택한 어댑터의 문서에 적혀 있지 않다면 애플리케이션이 그 동작에 기대면 안 됩니다.

## 드라이버별 실행 방식

| 어댑터                      | 방식            | 구조 검증 대상                                                      |
| --------------------------- | --------------- | ------------------------------------------------------------------- |
| PostgreSQL / `pg`           | `prepared-loop` | 이름 있는 문장을 순서대로 실행, 클라이언트별 문장 재사용 개수 제한  |
| MySQL / `mysql2`            | `prepared-loop` | prepare 한 번, execute N번, `unprepare()`로 캐시된 핸들을 닫고 제거 |
| MariaDB / Connector/Node.js | `native-bulk`   | `connection.batch()` 호출 한 번                                     |
| SQLite / `node:sqlite`      | `prepared-loop` | 준비된 문장 하나를 재사용                                           |
| SQLite / `better-sqlite3`   | `prepared-loop` | 준비된 문장 하나를 재사용                                           |
| SQLite / libSQL             | `remote-batch`  | `client.batch()` 호출 한 번                                         |
| SQLite / WASM               | `prepared-loop` | OO1 문장 하나를 반복해서 reset                                      |
| Cloudflare D1               | `remote-batch`  | `D1Database.batch()` 호출 한 번                                     |
| Oracle Thin                 | `native-bulk`   | `executeMany()` 호출 한 번                                          |
| SQL Server / Tedious        | `prepared-loop` | N번 execute 앞뒤로 prepare/unprepare 한 번씩                        |
| Bun.SQL                     | `prepared-loop` | 입력마다 네이티브 실행 한 번                                        |

리비전별 프로필과 기능 조건은 [런타임·드라이버 지원](/SQLBraid/v/1.0.2/reference/support.md)을 보세요.
