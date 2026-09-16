# 1.0.0-rc.1 릴리스 노트

> SQLBraid 1.0 릴리스 후보 표면과 증거 경계를 설명합니다.

이 문서는 1.0.0-rc.1 프리릴리스 문서이며 npm, GitHub, VS Code Marketplace 또는 Pages
발행을 승인하지 않습니다.

지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)가
기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별
실행 workflow에만 적용됩니다. 인접한 버전·runtime·profile·로컬 binding 또는
package 설치로 인증을 추론하지 마세요. 최종 exact-SHA Runtime, Docs, Release
gate와 명시적인 release 승인은 별도 요구사항입니다.

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

Release candidate에는 하나의 clean exact revision, 실행 가능한 tuple/capability 범위,
영문/한국어 문서 freshness, package/export 검사, immutable release dry-run이
필요합니다. 사용자 수락과 명시적 release 승인은 별도 gate입니다.

## Translation freshness

영문 페이지가 source content이며 추적하는 모든 페이지에는 한국어 pair가
있습니다. 같은 revision에서 영문과 한국어 파일을 함께 변경하고 두 언어의
code/API 의미를 보존한 뒤 `node scripts/validate-translations.mjs`를
실행하세요. Translation registry는 영문 source digest를 기록하며 stale 또는
누락된 entry는 Docs gate를 막습니다. 일반적인 API 변경에 opt-out을 추가하지
마세요.
