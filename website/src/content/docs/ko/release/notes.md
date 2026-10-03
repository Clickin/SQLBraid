---
title: 1.0.0 릴리스 노트
description: SQLBraid 1.0.0 GA 인터페이스와 capability 및 증거 경계를 설명합니다.
---

이 문서는 SQLBraid 1.0.0 GA 문서입니다. GA는 공개 인터페이스를 안정화합니다.
모든 드라이버에서 모든 기능을 보장하지는 않습니다.

[런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)는 지원되는 데이터베이스, 드라이버, 프로필, 런타임, capability 조합을 기록합니다.

## 1.0.0에 포함된 기능

- SQL-first template, 안전한 value bind, 명시적 result kind `rows`, `command`, `call`, `unknown`
- 제한된 `@braid` directive와 명시적 structural fragment
- 쿼리에 연결하거나 실행마다 지정하는 Standard Schema row mapping
- Direct physical executor와, provider/lease를 통한 명시적 pool 소유권
- `db.session(callback)` lease pinning, 중첩 session 재사용, `db.tx`
- 고정 transaction isolation literal과 `readOnly`. 잘못된 형식, 미지원, 중첩 option은 서로 다른 오류를 냄
- 후행 execution/row/stream option과 capability에 따른 `AbortSignal` cancellation
- input이 있거나 없는 prepared factory. 한 번 렌더링하는 logical shape lock
- lease 반환 전에 cleanup하는 native driver stream, 또는 명시적 `BRAID_STREAM_UNSUPPORTED`
- materialized routine `output`, 순서 있는 이질적 `resultSets`, 선택적 `returnValue`, OUT/INOUT/cursor의 명시적 경계
- I/O 전에 검증하고 실제 실행 mode를 보고하는 command 전용 동종 bulk
- observe 또는 fail만 하는 execution observer와 lazy diagnostic literalization
- 선택적 `@sqlbraid/opentelemetry` DB client span과 안정화된 duration metric.
  SDK/exporter는 애플리케이션이 소유함
- PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server dialect root와 driver subpath
- Bun SQL adapter family 하나. 사용자가 PostgreSQL, MySQL, MariaDB, SQLite 중 dialect를 선택함. connection 기반 자동 감지 없음
- public API가 동작하는 곳에서 기존 first-party driver adapter를 쓰는 Deno. Deno 전용 dialect 없음
- metadata, codegen, CLI JSON inspection, 표준 LSP, Vite lowering, 얇은 editor 통합
- 정확한 DB integer/decimal은 canonical string, 근사 IEEE 값은 number. JSON/temporal/container profile은 독립적임

## 명시적 unsupported 동작

`UnsupportedFeatureError(feature, code, message, options?)`는 안정적인
`BRAID_*` code를 전달합니다. 물리 driver 지원이 없는 활성 cancellation은
`BRAID_CANCEL_UNSUPPORTED`를 사용합니다. 이미 abort된 signal은 자신의
`reason`을 유지합니다. Stream, routine, output, hint, transaction, bulk 지원이
없으면 명시적으로 실패합니다. SQLBraid는 buffering, carrier 추측, hint 무시,
숨은 transaction 생성을 하지 않습니다.

- MySQL/mysql2는 emitted 이질적 `CALL` result set을 지원합니다. OUT/INOUT
  descriptor는 지원하지 않습니다. carrier를 신뢰할 수 있게 식별할 수 없기
  때문입니다.
- SQLite의 `db.call()` / `routine.call`은 unsupported입니다. 일반 SQLite SQL
  function이나 extension을 제한하지 않습니다.
- `callStream()`은 예약된 이름이며 구현되지 않았습니다. 호출할 수 있는 1.0.0
  API가 아닙니다.

[Capability 제한 사항](/SQLBraid/release/limitations/)을 참고하세요. 다음 내용이
포함됩니다: Bun 1.3.14 MySQL/MariaDB는 명시적 `readOnly`의 두 boolean 값을 모두
거부합니다. option을 생략하면 native session 기본값이 유지됩니다. Bun.SQL
PostgreSQL은 다르게 동작합니다.

Canonical capability key는 다음과 같습니다.

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

## 의도적인 비기능

SQLBraid는 다음이 아닙니다.

- ORM
- 완전한 SQL semantic compiler
- 범용 input codec
- SQL/result를 rewrite하는 interceptor
- 자동 retry/router
- audit store
- 범용 native prepared cache

임의 SELECT/JOIN result model을 추론하지 않습니다. object graph를 hydrate하지
않습니다. DML `RETURNING`/`OUTPUT`은 선택한 adapter의 정확한 증거가 달리
말하지 않으면 materialized입니다. Metadata는 open-world positive evidence입니다.

지원 artifact와 릴리스 artifact는 발행 전에 검증됩니다.

## npm과 VS Code artifact 보장 범위

공식 npm 패키지와 VS Code 확장 패키지는 릴리스 전에 일관성과 무결성 검증을 거칩니다.
