---
title: 현재 제한 사항
description: 1.0.0 GA 계약이 의도적으로 약속하지 않는 내용을 확인합니다.
---

- **인증은 정확한 tuple과 revision별입니다.** [지원 매트릭스](/SQLBraid/reference/support/)가 기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별 실행 workflow에만 지원 label과 증거가 적용됩니다. 인접한 버전·runtime·profile·로컬 binding 또는 package 설치로 인증을 추론하지 마세요. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release 승인은 별도 요구사항이며, CI 통과도 발행 승인이 아닙니다.
- **`db.all()`은 materialized입니다.** readonly array와 O(row-count) application memory를 사용합니다. 메모리가 중요하면 `db.stream()`을 사용하세요.
- **Routine streaming은 없습니다.** `callStream()`은 예약된 미구현 이름이며 호출 가능한 1.0.0 API가 아닙니다. materialized `db.call()`은 매핑 전에 routine resource를 소비하고 닫으며 raw cursor, portal, request, carrier row는 노출되지 않습니다.
- **MySQL 및 MariaDB prepared CALL OUT/INOUT descriptor는 지원하지 않습니다.** Emitted 이질적 `CALL` result set은 지원합니다. mysql2 3.x와 MariaDB Connector/Node.js 모두 prepared call용 OUT 파라미터 carrier를 구분하는 검증된 공개 API가 없으므로 추측하지 않습니다.
- **PostgreSQL refcursor call은 기존 transaction이 필요합니다.** refcursor는 transaction-bound portal이며 독립 ResultSet이 아닙니다. 숨은 transaction을 만들지 않습니다.
- **SQL Server cursor output은 application cursor가 아닙니다.** `CURSOR VARYING OUTPUT`은 bind 가능한 client ResultSet으로 노출되지 않으며 emitted `SELECT` 행은 일반 result set입니다.
- **SQLite의 `db.call()` / `routine.call`은 지원하지 않습니다.** 이는 adapter API 경계이며 SQLite SQL의 제한이 아닙니다. scalar/aggregate/window function과 virtual-table extension은 일반 SQL입니다. D1에는 callback transaction과 incremental cursor도 없습니다.
- **DML-returning은 materialized입니다.** `sql.rows`와 `db.execute`, `db.all`, `db.one`, `db.maybeOne`을 사용하고 `RETURNING`/`OUTPUT`의 cross-driver stream을 추론하지 마세요.
- **`db.bulk()`는 command-only입니다.** 하나의 DML shape를 lock하고 I/O 전에 모든 입력을 검증하며 하나의 lease를 사용하고 실제 mode를 보고합니다. Root bulk에는 portable atomicity/auto-chunking 약속이 없으므로 atomicity에는 `db.tx()`를 사용하세요.
- **Session과 transaction은 물리 scope API입니다.** `db.session()`은 하나의 provider lease를 고정하고 중첩 session/transaction 작업은 재사용합니다. Root escape 및 closed/sibling handle은 거부됩니다. Primitive가 없으면 `BRAID_SESSION_UNSUPPORTED` 또는 `BRAID_TX_UNSUPPORTED`를 사용합니다.
- **Transaction option은 고정되고 capability 기반입니다.** Isolation은 `read-uncommitted`, `read-committed`, `repeatable-read`, `serializable` 중 하나이며 `readOnly`는 별도입니다. Malformed runtime 값은 acquire 전에 `TypeError` / `BRAID_TX_OPTIONS_INVALID`, 유효하지만 지원되지 않는 값은 `BRAID_TX_OPTION_UNSUPPORTED`, 중첩 명시 option은 `BRAID_TX_OPTIONS_NESTED`로 실패합니다.
- **Bun.SQL MySQL/MariaDB의 명시적 access mode는 지원하지 않습니다.** `readOnly: true`와 `readOnly: false`를 모두 I/O 전에 `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`로 거부합니다. Native Bun 1.3.14의 read-only statement 실패는 rollback 뒤에도 남을 수 있어 오염된 reservation을 폐기합니다. 생략하면 session 기본값을 보존하며 read-write로 강제하지 않습니다. Bun.SQL PostgreSQL과 representation profile option은 변경하지 않습니다.
- **Cancellation은 capability 기반입니다.** 이미 abort된 signal은 자신의 `reason`을 보존합니다. 물리 cancellation이 없는 활성 signal은 I/O 전에 `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`로 실패하며 iteration 중지만 멈추는 것은 cancellation이 아닙니다.
- **범용 input codec이 없습니다.** 일반 interpolation은 driver-bound이며 JSON, temporal, custom-class, binary 규칙은 application/driver 책임입니다.
- **숫자 정확도는 profile별입니다.** 정확한 DB integer/decimal은 canonical string이고 근사 IEEE 값은 number입니다. `decodeExactInteger`는 opt-in transform입니다. Bun 1.3.14는 PostgreSQL/MySQL/MariaDB에 `{ bigint: true }`, SQLite에 `{ safeIntegers: true }`를 사용합니다. Integral `Number` row는 거부되며 PostgreSQL decimal은 text입니다. MySQL/MariaDB DECIMAL과 binary byte carrier는 직접 작성한 SQL text/hex 변환 없이 거부되고 SQLite native decimal은 unsupported입니다. D1은 safe-integer 범위의 guarded profile이며 exact text가 필요하면 authored `CAST(... AS TEXT)`를 사용하세요.
- **JSON과 temporal 정확도는 별도 profile입니다.** Parsed JSON은 nested number가 반올림되었을 수 있고 native `Date`는 fractional precision 또는 offset/zone 의미를 잃을 수 있습니다. 테스트한 text profile이나 authored `JSON_SERIALIZE`/`TO_CHAR`/`CONVERT` SQL을 사용하세요.
- **Container는 scalar 보장이 아닙니다.** Array, domain, range, multirange, composite, Oracle object/collection, SQL Server `sql_variant`, vector와 nested 값은 테스트 전까지 unclassified 또는 unsupported입니다.
- **Profile과 codegen은 일치해야 합니다.** Driver JSON/temporal/numeric option을 바꾸면 별도 evidence profile이며 runtime과 generated model은 그 TypePolicy를 재사용해야 합니다.
- **Bun SQL은 사용자가 dialect를 선택합니다.** `createBunSqlDatabase`는 `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`를 요구하고 자동 감지하지 않습니다. Bun 1.3.14 active cancellation은 `BRAID_CANCEL_UNSUPPORTED`로 실패하고 stream/routine carrier는 `BRAID_STREAM_UNSUPPORTED`, `BRAID_CALL_UNSUPPORTED`로 명시 실패합니다. `result.rows`/`result.command` metadata는 `bun-sql.result-kind-metadata` 조건에서 guarded됩니다. MySQL/MariaDB의 빈 `SELECT`와 영향 행 0인 DML/DDL은 실행 후 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있어 side effect가 이미 발생했을 수 있습니다.
- **Deno는 기존 adapter를 재사용합니다.** Public Node-compatible driver path가 Deno에서 동작할 수 있지만 Deno dialect를 만들거나 support tuple을 승격하지 않습니다.
- **SQL에서 TypeScript를 추론하지 않습니다.** 임의 SELECT/JOIN 결과 추론과 relation graph hydrate는 범위 밖입니다.
- **Observer mutation/retry/routing이 없습니다.** Observer는 검사하거나 실패시킬 수 있지만 SQL/bind를 바꾸거나 retry/route하지 않습니다.
- **Metadata는 invalidity 증거가 아닙니다.** 누락된 object는 open-world이고 routine argument 목록은 불완전할 수 있습니다.
- **Custom driver는 release support가 아닙니다.** `QueryExecutor`/`ConnectionProvider`를 구현하고 독립적인 exact evidence를 제공하세요.
- **Tooling은 Node 우선입니다.** Compiler, CLI, LSP, metadata/codegen, Vite는 별도 build/runtime concern이며 Node-only driver를 browser bundle에 넣지 마세요.

이는 숨겨진 fallback이 아닌 의도적인 경계입니다. [루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/), [트랜잭션](/SQLBraid/runtime/transactions/), [지원 매트릭스](/SQLBraid/reference/support/)를 참고하세요.
