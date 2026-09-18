# 1.0.0 릴리스 노트

> SQLBraid 1.0.0 GA contract와 capability 및 증거 경계를 설명합니다.

이 문서는 SQLBraid 1.0.0 GA 문서입니다. GA는 공개 contract의 안정화를 뜻하며
모든 드라이버에서 모든 기능을 보장하지는 않습니다.

지원 여부는 [런타임/드라이버 지원 매트릭스](/SQLBraid/v/1.0.0/reference/support.md)에 기록된 데이터베이스, 드라이버, 프로필, 런타임 조합을 기준으로 합니다.

## 포함된 contract

- SQL-first template, 안전한 value bind, 명시적 `rows`, `command`, `call`, `unknown` result kind
- 제한된 `@braid` directive와 명시적 structural fragment
- Query-bound 및 실행별 Standard Schema row mapping
- Direct physical executor와 명시적 provider/lease pool 소유권
- `db.session(callback)` lease pinning, 중첩 session 재사용, `db.tx`
- 고정 transaction isolation literal과 `readOnly`, malformed/unsupported/nested option의 구분
- 후행 execution/row/stream option과 capability 기반 `AbortSignal` cancellation
- 한 번 렌더링하는 zero-input/input prepared factory와 logical shape lock
- lease 반환 전 cleanup을 수행하는 native driver stream 또는 명시적 `BRAID_STREAM_UNSUPPORTED`
- materialized routine `output`, 순서 있는 heterogeneous `resultSets`, 선택적 `returnValue`, 명시적 OUT/INOUT/cursor 경계
- I/O 전 검증과 실제 실행 mode를 보고하는 동종 command-only bulk
- observe/fail-only execution observer와 lazy diagnostic literalization
- 애플리케이션이 SDK/exporter를 소유하는 선택적
  `@sqlbraid/opentelemetry` DB client span 및 안정화된 duration metric
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server dialect root와 driver subpath
- PostgreSQL, MySQL, MariaDB, SQLite 중 사용자가 선택하는 Bun SQL adapter family; connection auto-detection 없음
- public API가 동작하는 경우 기존 first-party driver를 재사용하는 Deno; Deno 전용 dialect 없음
- metadata, codegen, CLI JSON inspection, 표준 LSP, Vite lowering, 얇은 editor 통합
- 정확한 DB integer/decimal은 canonical string, 근사 IEEE 값은 number이며 JSON/temporal/container profile은 독립적임

## 명시적 unsupported 동작

`UnsupportedFeatureError(feature, code, message, options?)`는 안정적인
`BRAID_*` code를 전달합니다. 물리 driver 지원이 없는 활성 cancellation은
`BRAID_CANCEL_UNSUPPORTED`를 사용하고 이미 abort된 signal은 자신의
`reason`을 보존합니다. Stream, routine, output, hint, transaction, bulk
지원이 없으면 buffering, carrier 추측, hint 무시, 숨은 transaction 대신
명시적으로 실패합니다.

MySQL/mysql2는 emitted 이질적 `CALL` result set을 지원하지만, carrier를
신뢰할 수 있게 식별할 수 없으므로 OUT/INOUT descriptor는 지원하지 않습니다.
SQLite의 `db.call()` / `routine.call`은 unsupported이며 일반 SQLite SQL
function이나 extension을 제한한다는 뜻은 아닙니다. `callStream()`은 예약된
미구현 이름이며 호출 가능한 1.0.0 API가 아닙니다.
[Capability 제한 사항](/SQLBraid/v/1.0.0/release/limitations.md)도 참고하세요.
Bun 1.3.14 MySQL/MariaDB는 명시적 `readOnly`의 두 boolean 값을 모두 거부하고
생략하면 native session 기본값을 보존하며, Bun.SQL PostgreSQL의 동작은 다릅니다.

Canonical capability key는 다음과 같습니다.

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## 의도적인 비기능

SQLBraid는 ORM, 완전한 SQL semantic compiler, 범용 input codec, SQL/result
rewrite interceptor, 자동 retry/router, audit store, 범용 native prepared
cache가 아닙니다. 임의 SELECT/JOIN result model을 추론하거나 object graph를
hydrate하지 않습니다. DML `RETURNING`/`OUTPUT`은 선택한 adapter의 정확한
증거가 달리 말하지 않는 한 materialized입니다. Metadata는 open-world
positive evidence입니다.

릴리스에는 기능과 지원 조합을 검증한 결과가 포함됩니다.

## npm과 VS Code artifact 보장 범위

공식 npm 및 VS Code 확장 패키지는 릴리스 전 일관성과 무결성 검증을 거칩니다.
