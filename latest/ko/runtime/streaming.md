# 스트리밍

> 버퍼 없이 행을 반복합니다. 물리 리스와 드라이버 정리는 SQLBraid가 맡습니다.

행을 만드는 일반 쿼리에는 `db.stream`을 쓰세요.

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()`은 드라이버의 실제 스트리밍 경로입니다. `db.all()`을 호출한 뒤 버퍼링된 배열을 하나씩 내보내는 방식이 아닙니다. `db.all()`은 일부러 읽기 전용 배열로 모두 읽으며, 행 수에 비례해 애플리케이션 메모리를 씁니다. 집합 반환 함수와 테이블 값 확장은 일반 `sql.rows` 쿼리입니다.

## 소유권과 정리

풀을 쓰는 루트 스트림은 드라이버 리소스가 끝날 때까지 물리 리스를 붙잡고 있습니다. 정리는 다음 순서로 일어납니다.

1. 행 전달을 멈춥니다.
2. 드라이버 커서, 요청, 이터레이터를 닫거나, 비우거나, 취소합니다.
3. 리스를 반환하거나 폐기합니다.
4. 스트림 종료 이벤트를 냅니다.

이 순서는 끝까지 읽었을 때, 소비자 오류, 매퍼 오류, `AbortSignal`, `for await`의 조기 `break`에 모두 적용됩니다.

직접 연결 스트림은 자신의 물리 리소스에 다시 들어갈 수 없습니다. SQLBraid는 교착 상태에 빠지지 않고 `BRAID_STREAM_SCOPE`로 거부합니다. 트랜잭션 스트림은 고정된 커넥션에 머물며, 겹치는 작업을 금지합니다. 스트림이 살아 있는 동안 트랜잭션 콜백에서 반환하지 마세요.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

시그널이 이미 중단된 상태면 작업은 그 `reason`으로 reject됩니다. 활성 시그널에는 물리적 취소 기능이 필요합니다. 기능이 없으면 어댑터가 I/O 전에 `UnsupportedFeatureError`(기능 `statement.cancel`, 코드 `BRAID_CANCEL_UNSUPPORTED`)로 거부합니다. 반복만 멈추는 것은 취소가 아닙니다.

## 공식 어댑터별 기본 수단

| 어댑터                      | 기본 수단                           | 경계                                                                                                                             |
| --------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`           | `pg-cursor` 묶음 읽기               | 선택 사항인 피어 의존성이며, 없으면 `BRAID_STREAM_UNSUPPORTED`. 중단 시 물리 클라이언트 취소를 쓰고, 필요하면 리스를 폐기합니다. |
| MySQL / `mysql2`            | 원시 준비된 문장 `Execute.stream()` | 준비된 문장의 바이너리 실행을 유지합니다. 리스 반환 전에 비우거나 폐기합니다.                                                    |
| MariaDB / Connector/Node.js | 네이티브 스트림 이터레이터          | MariaDB 드라이버 자체의 근거를 씁니다. `mysql2`에서 물려받지 않습니다.                                                           |
| SQLite / `node:sqlite`      | `StatementSync.iterate()`           | 네이티브 이터레이터 종료가 정리 경계입니다.                                                                                      |
| SQLite / `better-sqlite3`   | `Statement#iterate()`               | 동기 호출이며 이벤트 루프를 막습니다. 이터레이터 return이 정리 경계입니다.                                                       |
| SQLite / libSQL             | 지원하는 클라이언트 API에는 없음    | `BRAID_STREAM_UNSUPPORTED`. 전체 ResultSet을 버퍼링하지 마세요.                                                                  |
| SQLite / WASM               | OO1 step/reset/finalize             | 브라우저·Worker의 직접 연결 리소스이며, 한 번에 소유자는 하나입니다.                                                             |
| Cloudflare D1               | 없음                                | `BRAID_STREAM_UNSUPPORTED`. 스트리밍을 흉내 내려고 페이지 단위로 나눠 읽지 마세요.                                               |
| Oracle Thin                 | `ResultSet`                         | 모든 ResultSet을 닫습니다. 닫기가 실패하면 리스를 폐기합니다.                                                                    |
| SQL Server / Tedious        | 요청 행 이벤트 + 크기 제한 큐       | 요청이 끝난 다음에 리스를 반환합니다.                                                                                            |
| Bun.SQL                     | 없음                                | `BRAID_STREAM_UNSUPPORTED`. 전체 결과를 버퍼링하지 마세요.                                                                       |

이것은 드라이버 기능이며 방언의 속성이 아닙니다. 직접 만든 실행기는 `QueryExecutor.stream`을 구현하거나, 항상 `BRAID_STREAM_UNSUPPORTED`로 실패해야 합니다. 루틴 커서 스트리밍은 메모리로 읽는 루틴 규칙에 포함되지 않습니다. 정규화되고 닫힌, 서로 다른 결과 집합이 필요하면 `db.call()`을 쓰세요.

DML `RETURNING`/`OUTPUT`은 메모리로 읽습니다. SQL의 RETURNING 문법이 모든 드라이버에서 스트리밍된다고 생각하지 마세요. 검증된 드라이버 기능은 [지원 매트릭스](/SQLBraid/latest/reference/support.md)를 보세요.
