---
title: 스트리밍
description: 버퍼 없이 행을 순회합니다. SQLBraid가 물리 lease와 driver cleanup을 소유합니다.
---

행을 만드는 일반 query에는 `db.stream`을 사용하세요.

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()`은 실제 driver streaming 경로입니다. `db.all()`을 호출해 버퍼
배열을 내보내지 않습니다. `db.all()`은 의도적으로 readonly array를
materialize합니다. 행 수에 비례하는 application memory를 사용합니다.
Set-returning function과 table-valued extension은 일반 `sql.rows` query입니다.

## 소유권과 cleanup

Pooled root stream은 driver resource가 terminal이 될 때까지 물리 lease를
유지합니다. Cleanup은 다음 순서로 진행됩니다.

1. 행 전달을 멈춥니다.
2. driver cursor/request/iterator를 close, drain, cancel합니다.
3. lease를 반환하거나 폐기합니다.
4. terminal stream event를 내보냅니다.

이 순서는 exhaustion, consumer 오류, mapper 오류, `AbortSignal`, `for await`의
조기 `break`에 모두 적용됩니다.

Direct stream은 자신의 물리 resource에 재진입할 수 없습니다. SQLBraid는
`BRAID_STREAM_SCOPE`로 거부합니다. deadlock되지 않습니다. Transaction stream은
pinned connection에 남고 겹치는 작업을 금지합니다. stream이 살아 있는 동안
transaction callback에서 반환하지 마세요.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

이미 abort된 signal은 자신의 `reason`으로 거부됩니다. 활성 signal에는 물리
cancellation capability가 필요합니다. 없으면 adapter가 I/O 전에
`UnsupportedFeatureError`, feature `statement.cancel`,
`BRAID_CANCEL_UNSUPPORTED`로 거부합니다. iteration만 멈추는 것은
cancellation이 아닙니다.

## First-party primitive

| Adapter                     | Primitive                         | 경계                                                                                                                              |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`           | `pg-cursor` read batch            | Optional peer가 없으면 `BRAID_STREAM_UNSUPPORTED`입니다. Abort는 물리 client cancellation을 사용하고 필요하면 lease를 폐기합니다. |
| MySQL / `mysql2`            | raw prepared `Execute.stream()`   | prepared/binary 실행을 유지하고 lease 반환 전에 drain 또는 discard합니다.                                                         |
| MariaDB / Connector/Node.js | native stream iterator            | 별도 MariaDB driver 증거이며 `mysql2`에서 상속되지 않습니다.                                                                      |
| SQLite / `node:sqlite`      | `StatementSync.iterate()`         | Native iterator 종료가 cleanup 경계입니다.                                                                                        |
| SQLite / `better-sqlite3`   | `Statement#iterate()`             | 동기식이고 event loop를 block하며 iterator return이 cleanup 경계입니다.                                                           |
| SQLite / libSQL             | 지원 client 표면에 없음           | `BRAID_STREAM_UNSUPPORTED`; 전체 ResultSet을 buffering하지 않습니다.                                                              |
| SQLite / WASM               | OO1 step/reset/finalize           | Direct browser/Worker resource이며 한 번에 하나의 owner만 사용합니다.                                                             |
| Cloudflare D1               | 없음                              | `BRAID_STREAM_UNSUPPORTED`; streaming을 흉내 내려고 paginate하지 않습니다.                                                        |
| Oracle Thin                 | `ResultSet`                       | 모든 ResultSet을 닫고 close 실패 시 lease를 폐기합니다.                                                                           |
| SQL Server / Tedious        | request row event + bounded queue | Request 완료가 lease 반환보다 먼저입니다.                                                                                         |
| Bun.SQL                     | 없음                              | `BRAID_STREAM_UNSUPPORTED`; 전체 result를 buffer하지 않습니다.                                                                    |

이것은 driver capability입니다. dialect의 속성이 아닙니다. Custom executor는
`QueryExecutor.stream`을 구현하거나 `BRAID_STREAM_UNSUPPORTED`로 결정적으로
실패해야 합니다. Routine cursor streaming은 materialized routine 규칙에 포함되지
않습니다. 정규화되고 닫힌 이질적 result set에는 `db.call()`을 사용하세요.

DML `RETURNING`/`OUTPUT` 결과는 materialized 상태로 남습니다. SQL에 작성한
returning 구문이 모든 드라이버에서 stream된다고 가정하지 마세요. 검증된
드라이버별 기능은 [지원 매트릭스](/SQLBraid/reference/support/)를 참고하세요.
