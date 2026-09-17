---
title: 1.0.0 릴리스 노트
description: SQLBraid 1.0.0 GA contract와 capability 및 증거 경계를 설명합니다.
---

이 문서는 SQLBraid 1.0.0 GA 문서입니다. GA는 공개 contract의 안정화를 뜻하며
모든 driver에서 모든 capability를 보장하지 않습니다. npm, GitHub, VS Code
Marketplace 또는 Pages 발행을 승인하지 않습니다.

지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)가
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

MySQL/mysql2는 emitted 이질적 `CALL` result set을 지원하지만, carrier를
신뢰할 수 있게 식별할 수 없으므로 OUT/INOUT descriptor는 지원하지 않습니다.
SQLite의 `db.call()` / `routine.call`은 unsupported이며 일반 SQLite SQL
function이나 extension을 제한한다는 뜻은 아닙니다. `callStream()`은 예약된
미구현 이름이며 호출 가능한 1.0.0 API가 아닙니다.
[Capability 제한 사항](/SQLBraid/release/limitations/)도 참고하세요.
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

Release에는 하나의 clean exact revision, 실행 가능한 tuple/capability 범위,
영문/한국어 문서 freshness, package/export 검사, immutable release dry-run이
필요합니다. 사용자 수락과 명시적 release 승인은 별도 gate입니다.

## npm과 VS Code artifact 보장 범위

**Release** workflow는 npm tarball을 패키징하고 검증합니다.
`release-manifest.json`은 패키지 파일명, SHA-256, SHA-512 integrity를
기록하고, `pack-check-success.json`은 패키지 이름과 SHA-256을 버전 및
source commit에 연결합니다. 이 workflow는 `SQLBRAID_SKIP_VSIX=true`를
설정합니다. 이전 실행 복구는 원본 npm candidate, manifest, stamp,
prepared build를 복구하며 VSIX는 포함하지 않습니다. npm의 draft GitHub
Release에는 manifest, staged-publication report, durable release-evidence
summary가 첨부되며 확장 파일은 첨부되지 않습니다.

별도로 dispatch하는 **VS Code Release** workflow는 정확한 VSIX를 빌드하고
extension identity, 번들 CLI/language-server 버전 일치, 깨끗한 editor
profile 실행을 검증합니다. 패키징 과정은 SHA-256을 출력합니다.
`sqlbraid-vscode-<version>` artifact는 14일간 보존됩니다. Open VSX의
trusted publishing은 재빌드 없이 이 artifact를 사용하고, Microsoft
Marketplace에는 같은 VSIX를 수동으로 전달합니다. VSIX와 해당 workflow
identity는 따로 보관하세요. npm manifest, pack-check stamp, 이전 실행
복구는 VSIX를 증명하거나 복구하지 않습니다.

## Translation freshness

영문 페이지가 source content이며 추적하는 모든 페이지에는 한국어 pair가
있습니다. 같은 revision에서 영문과 한국어 파일을 함께 변경하고 두 언어의
code/API 의미를 보존한 뒤 `node scripts/validate-translations.mjs`를
실행하세요. Translation registry는 영문 source digest를 기록하며 stale 또는
누락된 entry는 Docs gate를 막습니다. 일반적인 API 변경에 opt-out을 추가하지
마세요.
