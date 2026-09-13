---
title: 스트리밍
description: SQLBraid가 물리적 lease와 드라이버 정리를 소유하는 동안 버퍼링 없이 행을 순회합니다.
---

일반 행 쿼리에는 `db.stream`을 사용하세요.

```ts
for await (const row of db.stream(sql.rows<UserRow>`
  SELECT id, name FROM users ORDER BY id
`)) {
  await consume(row);
}
```

`db.stream()`은 실제 드라이버 스트리밍 경로이며 `db.all()`을 호출해 버퍼 배열을 다시 내보내지 않습니다. `db.all()`은 의도적으로 readonly 배열을 materialize하므로 O(row-count) 애플리케이션 메모리를 사용합니다. Set-returning function과 table-valued extension도 일반 `sql.rows` 쿼리이므로 같은 선택을 사용합니다.

## 소유권과 정리

풀 루트 stream은 드라이버 리소스가 terminal 상태가 될 때까지 물리적 lease를 유지합니다. 정리 순서는 다음과 같습니다.

1. consumer에 행 전달을 중지합니다.
2. 드라이버 cursor/request/iterator를 close, drain 또는 cancel합니다.
3. 그 후에만 lease를 반환하며 protocol을 재사용할 수 없으면 폐기합니다.
4. terminal stream event를 발생시킵니다.

이는 exhaustion, consumer 오류, mapper 오류, `AbortSignal`, `for await` 조기 `break` 모두에 적용됩니다. 직접 stream이 자신의 물리 리소스에 다시 진입하면 deadlock 대신 `BRAID_STREAM_SCOPE`를 발생시킵니다. 트랜잭션 stream은 고정된 연결을 사용하고 겹치는 작업을 금지하며 버려진 iterator는 rollback을 일으킵니다.

consumer가 취소할 수 있다면 `AbortSignal`을 전달하세요.

```ts
const controller = new AbortController();
const stream = db.stream(query, { signal: controller.signal });
controller.abort();
```

stream이 살아 있는 동안 transaction callback을 반환하지 마세요.

## 첫 번째 파티 primitive

| 어댑터 | primitive | 경계 |
| --- | --- | --- |
| PostgreSQL / `pg` | `pg-cursor` batch read | Optional peer가 없으면 `BRAID_STREAM_UNSUPPORTED`입니다. 정상 종료는 cursor를 닫고, abort는 대기 중 read도 중단하도록 물리적 `Client.end()` 완료 후 lease를 폐기합니다. Abort 후 direct client는 교체해야 합니다. |
| MySQL / `mysql2` | raw prepared `Execute.stream()` | `mysql2/promise` 뒤의 raw connection을 사용하고 prepared/binary 실행을 보존하며 lease 반환 전에 drain 또는 discard합니다. text `query()`로 낮추지 않습니다. |
| SQLite / `node:sqlite` | `StatementSync.iterate()` | native iterator가 끝난 뒤에만 database 리소스를 재사용합니다. 가짜 서버 cursor close API를 만들지 않습니다. |
| Oracle / `node-oracledb` Thin | `ResultSet` | exhaustion, break, abort, mapper 오류에서 ResultSet을 닫으며 close 실패는 lease를 poison/discard합니다. |
| SQL Server / Tedious | Request row event와 bounded pause/resume queue | lease 반환 전에 request가 완료되어야 하며 cancellation은 물리 연결을 폐기할 수 있습니다. |

이는 dialect가 아닌 드라이버 capability입니다. 사용자 지정 executor는 필요한 `QueryExecutor.stream` 계약을 구현하거나 `BRAID_STREAM_UNSUPPORTED`로 결정적으로 실패해야 합니다. 런타임에서 optional property를 추측하는 방식은 capability 모델이 아닙니다.

루틴 cursor streaming은 materialized 루틴 계약에 포함되지 않습니다. 정규화되고 닫힌 이질적 result set에는 `db.call()`을, 일반 행 stream에는 이 API를 사용하세요.

[트랜잭션](/SQLBraid/runtime/transactions/), [observer](/SQLBraid/runtime/observers/), [루틴 호출](/SQLBraid/concepts/routines/)도 참고하세요.
