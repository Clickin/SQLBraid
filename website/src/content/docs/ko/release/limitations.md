---
title: 현재 제한 사항
description: 1.0.0 GA가 의도적으로 약속하지 않는 내용을 설명합니다.
---

- **인증은 정확한 tuple과 revision별입니다.** [지원 매트릭스](/SQLBraid/reference/support/)가 기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별 실행 workflow에만 지원 label과 증거가 적용됩니다. 인접한 버전, runtime, profile, 로컬 binding, package 설치로 인증을 추론하지 마세요. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release 승인은 별도 요구사항입니다. CI 통과는 발행 승인이 아닙니다.
- **`db.all()`은 materialized입니다.** readonly array를 반환합니다. 행 수에 비례하는 application memory를 사용합니다. 제한된 메모리가 중요하면 `db.stream()`을 사용하세요.
- **Routine streaming은 포함되지 않습니다.** `callStream()`은 예약된 이름이며 구현되지 않았습니다. 호출할 수 있는 1.0.0 API가 아닙니다. materialized `db.call()`은 매핑 전에 routine resource를 읽고 닫습니다. raw cursor, portal, request, carrier row는 밖으로 나오지 않습니다.
- **MySQL과 MariaDB prepared CALL OUT/INOUT descriptor는 지원하지 않습니다.** Emitted 이질적 `CALL` result set은 지원합니다. mysql2 3.x와 MariaDB Connector/Node.js 모두 prepared call OUT carrier를 구분하는 검증된 공개 discriminator가 없습니다. 따라서 SQLBraid는 carrier 행을 추측하지 않습니다.
- **PostgreSQL refcursor call에는 기존 transaction이 필요합니다.** refcursor는 transaction에 속한 portal입니다. 독립 ResultSet이 아닙니다. SQLBraid는 숨은 transaction을 만들지 않습니다.
- **SQL Server cursor output은 application cursor가 아닙니다.** `CURSOR VARYING OUTPUT`은 bind할 수 있는 client ResultSet으로 노출되지 않습니다. emitted `SELECT` 행은 일반 result set입니다.
- **SQLite의 `db.call()` / `routine.call`은 지원하지 않습니다.** 이것은 adapter API 경계입니다. SQLite SQL의 제한이 아닙니다. scalar/aggregate/window function과 virtual-table extension은 일반 SQL입니다. D1에는 callback transaction과 incremental cursor도 없습니다.
- **DML-returning은 materialized입니다.** `sql.rows`와 `db.execute`, `db.all`, `db.one`, `db.maybeOne`을 사용하세요. `RETURNING`/`OUTPUT`이 모든 드라이버에서 stream된다고 추론하지 마세요.
- **`db.bulk()`는 command 전용입니다.** 하나의 DML shape를 lock합니다. I/O 전에 모든 입력을 검증합니다. lease 하나를 사용합니다. 실제 mode를 보고합니다. Root bulk에는 portable atomicity나 자동 chunking 약속이 없습니다. atomicity에는 `db.tx()`를 사용하세요.
- **Session과 transaction은 물리 scope API입니다.** `db.session()`은 provider lease 하나를 고정합니다. 중첩 session/transaction 작업은 같은 lease를 사용합니다. Root escape와 닫힌 handle, sibling handle은 거부됩니다. Primitive가 없으면 `BRAID_SESSION_UNSUPPORTED`나 `BRAID_TX_UNSUPPORTED`를 사용합니다.
- **Transaction option은 고정되어 있고 capability에 따릅니다.** Isolation은 `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable` 중 하나입니다. `readOnly`는 별도입니다. 잘못된 형식의 runtime 값은 acquire 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패합니다. 유효하지만 지원되지 않는 값은 `BRAID_TX_OPTION_UNSUPPORTED`를 사용합니다. 중첩 명시 option은 `BRAID_TX_OPTIONS_NESTED`를 사용합니다.
- **Bun.SQL MySQL/MariaDB의 명시적 access mode는 지원하지 않습니다.** `readOnly: true`와 `readOnly: false`를 모두 I/O 전에 `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다. Native Bun 1.3.14에서 read-only statement 실패는 rollback 뒤에도 남을 수 있습니다. 오염된 reservation은 폐기됩니다. option을 생략하면 session 기본값이 유지됩니다. read-write가 강제되지 않습니다. Bun.SQL PostgreSQL과 representation profile option은 바뀌지 않습니다.
- **Cancellation은 capability에 따릅니다.** 이미 abort된 signal은 자신의 `reason`을 유지합니다. 물리 cancellation이 없는 활성 signal은 I/O 전에 `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`로 실패합니다. iteration만 멈추는 것은 cancellation이 아닙니다.
- **범용 input codec이 없습니다.** 일반 interpolation은 driver가 bind합니다. JSON, temporal, custom-class, binary 규칙은 application과 driver의 책임입니다.
- **숫자 정확도는 profile별입니다.** 정확한 DB integer/decimal은 canonical string입니다. 근사 IEEE 값은 number입니다. `decodeExactInteger`는 선택적 transform입니다. Bun 1.3.14는 PostgreSQL/MySQL/MariaDB에 `{ bigint: true }`를, SQLite에 `{ safeIntegers: true }`를 사용합니다. Integral `Number` row는 거부됩니다. PostgreSQL decimal은 text입니다. MySQL/MariaDB DECIMAL과 binary byte carrier는 SQL에서 text/hex로 변환하지 않으면 거부됩니다. SQLite native decimal은 unsupported입니다. D1은 safe-integer 범위로 guarded됩니다. exact text가 필요하면 SQL에 `CAST(... AS TEXT)`를 작성하세요.
- **JSON과 temporal 정확도는 별도 profile입니다.** Parsed JSON은 중첩 숫자가 반올림되었을 수 있습니다. native `Date`는 fractional precision이나 offset/zone 의미를 잃을 수 있습니다. 테스트한 text profile을 사용하거나 SQL에 `JSON_SERIALIZE`/`TO_CHAR`/`CONVERT`를 작성하세요.
- **Container는 scalar 보장이 아닙니다.** Array, domain, range, multirange, composite, Oracle object/collection, SQL Server `sql_variant`, vector, 중첩 값은 테스트 전까지 unclassified 또는 unsupported입니다.
- **Profile과 codegen은 일치해야 합니다.** Driver의 JSON/temporal/numeric option을 바꾸면 다른 evidence profile이 됩니다. runtime과 생성 모델은 그 TypePolicy를 사용해야 합니다.
- **Bun SQL dialect는 사용자가 선택합니다.** `createBunSqlDatabase`는 `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`를 요구합니다. 자동 감지하지 않습니다. Bun 1.3.14에서 active cancellation은 `BRAID_CANCEL_UNSUPPORTED`로 실패합니다. stream/routine carrier는 `BRAID_STREAM_UNSUPPORTED`와 `BRAID_CALL_UNSUPPORTED`로 명시적으로 실패합니다. `result.rows`/`result.command` metadata는 `bun-sql.result-kind-metadata` 조건에서 guarded입니다. MySQL/MariaDB의 빈 `SELECT`와 영향 행이 0인 DML/DDL은 실행 후 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패합니다. 따라서 side effect가 이미 발생했을 수 있습니다.
- **Deno는 기존 adapter를 사용합니다.** Public Node 호환 driver 경로는 Deno에서 동작할 수 있습니다. 이것이 Deno dialect를 만들거나 support tuple을 승격하지 않습니다.
- **SQL에서 TypeScript를 추론하지 않습니다.** 임의 SELECT/JOIN 결과 추론과 relation graph hydrate는 범위 밖입니다.
- **Observer는 변경, retry, routing을 할 수 없습니다.** Observer는 작업을 검사하거나 실패시킬 수 있습니다. SQL을 rewrite하거나 bind를 바꾸거나 retry/route할 수 없습니다.
- **Metadata는 증거입니다. invalidity를 증명하지 않습니다.** 누락된 object는 open-world입니다. routine argument 목록은 불완전할 수 있습니다.
- **Custom driver는 release support가 아닙니다.** `QueryExecutor`/`ConnectionProvider`를 구현하고 독립적인 exact evidence를 제공하세요.
- **Tooling은 Node 우선입니다.** Compiler, CLI, LSP, metadata/codegen, Vite 통합은 별도의 build/runtime 관심사입니다. Node 전용 driver를 browser bundle에 넣지 마세요.

이 경계는 의도적입니다. 숨겨진 fallback 동작이 아닙니다. [루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/), [트랜잭션](/SQLBraid/runtime/transactions/), [지원 매트릭스](/SQLBraid/reference/support/)를 참고하세요.
