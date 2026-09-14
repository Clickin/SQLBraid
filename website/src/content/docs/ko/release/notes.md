---
title: PV18 릴리스 노트
description: 프로필 일관성, container fidelity, 값 정확도 경계를 포함하는 SQLBraid 프리릴리스 표면입니다.
---

이 문서는 npm RC나 stable 발행을 주장하지 않는 PV18 초안입니다. PV18은
`2119d9676b05fb2531eaf7aac1ef37741600ba40` review baseline에서 시작했습니다.
프로필/컨테이너 계약의 최종 Runtime, Docs, Release dry-run gate는 대기
중이므로 final SHA나 workflow run을 주장하지 않습니다. 과거 PV16/PV17 증거는
provenance로만 보존합니다.

## 포함된 계약

- PostgreSQL, MySQL, SQLite, Oracle Thin, SQL Server/Tedious dialect 및 어댑터 경로와 명시적인 direct/pool 소유권 경계
- `sql.rows`, `sql.command`, `sql.call`, 안전한 value bind, 구조적 fragment, 동적 `@braid` 지시문
- `all()` buffer가 아닌 실제 드라이버 경로인 `db.stream()`과 물리적 lease 반환 전 어댑터별 정리
- 행과 이질적인 루틴 result-set tuple의 Standard Schema 매핑
- scalar `output`, 순서가 있는 `resultSets`, 선택적 `returnValue` 루틴 채널과 `sql.out`/`sql.inOut` 방향 helper
- PostgreSQL transaction-bound refcursor, Oracle explicit/implicit cursor result, native RETURN status용 SQL Server 명시적 procedure metadata, 의도적인 SQLite 루틴 거부
- MySQL raw prepared `Execute.stream()` 및 검증된 carrier discriminator가 없는 OUT/INOUT의 명시적 거부
- PostgreSQL/SQLite/MariaDB native `RETURNING`, SQL Server `OUTPUT`, Oracle `RETURNING ... INTO`와 `sql.out()`을 사용하는 materialized DML-returning 계약. dialect 간 SQL rewrite는 하지 않음
- I/O 전 shape 검증, 하나의 physical lease, `native-bulk`/`pipeline`/`prepared-loop`/`remote-batch` 모드를 사용하는 command-only `db.bulk(inputs, factory)`. implicit transaction과 auto-chunking 약속 없음
- 별도 `@sqlbraid/mariadb` dialect와 MariaDB Connector/Node.js 어댑터. MariaDB의 `mysql2` 연결은 best-effort 호환
- Direct Browser SQLite WASM 및 Cloudflare D1 SQLite 어댑터 경로. D1은 materialized 실행과 native remote batch를 사용
- `durationMs`, 민감하지 않은 call result 구조, lazy diagnostic literalization을 포함하는 execution observer
- TypeScript와 framework 변환을 Vite에 맡기고 TSX와 source-map 조합을 보존하는 `@sqlbraid/vite` Vite 8 pre-transform
- 선택적 metadata, inspector, 결정적 codegen, CLI JSON inspection, 표준 stdio LSP, 얇은 VS Code 통합
- PV18 숫자 정확도: 정확한 DB 정수와 10진수는 canonical string, IEEE-754
  근사 이진 값은 JavaScript number입니다. Numeric metadata는 DB semantics,
  raw representation, transport fidelity를 분리하며 `decodeExactInteger`와
  Decimal 등 풍부한 타입은 애플리케이션 transform입니다.
- JSON은 lossless text와 parsed object 편의를 구분하고 temporal text와
  native `Date` 편의를 구분합니다. Driver option과 사용자가 작성한 SQL
  cast/format expression은 별도 프로필이며 SQLBraid는 SQL을 rewrite하지
  않습니다.
- PostgreSQL, mysql2, MariaDB는 `typePolicyForProfile({ json, temporal })`와
  profile descriptor를 export합니다. runtime과 codegen은 같은 프로필을
  재사용해야 하며 native PostgreSQL JSON root는 좁은 계약이 없으면
  `unknown`, temporal mapping은 DB type별입니다.
- Driver raw 값과 SQLBraid canonical 값을 구분합니다. 정확한 ID는 canonical
  decimal string이고 `affectedRows`, `rowCount`, procedure status, bulk input
  count는 safe operational number입니다.
- Scalar fidelity는 array, domain, range, composite, Oracle object, SQL
  Server `sql_variant`, vector, parsed JSON root에 재귀적으로 적용되지
  않습니다. Container-specific 증거가 생길 때까지 unknown/unclassified/
  unsupported로 둡니다.
- 일반 `undefined` IN bind는 acquisition 전에
  `BRAID_BIND_VALUE_UNSUPPORTED`로 실패하고 `null`은 SQL `NULL`입니다.
  SQLite INTEGER는 내부 native int64 transport를 사용할 수 있지만 출력은
  canonical string이며 public integer mode는 없습니다.

## 검증 상태

PV18 프로필의 최종 gate가 아직 없으므로 공유 매니페스트의 변경된 표현
cell은 Pending입니다. 대기 중인 Runtime gate는 Node 22의 전체 Vitest,
Node 24의 기존 `test:all`, fidelity benchmark, 하나의 최종 revision에서
실행하는 Docs/Release dry-run입니다. docs-pages workflow는 push에서
자동 검증하지만 `deploy=true`인 명시적인 `workflow_dispatch`에서만 Pages
배포와 history 업데이트를 수행합니다. D1의 managed SQLite 버전은 공개되지
않으며 Oracle Free 23.9가 19c를 인증하지는 않습니다. 증거는 revision별이며
이후 변경은 자체 게이트가 필요합니다. 실제 발행은 생략했고, 사용자 수락과
명시적인 릴리스 승인은 별도입니다.

## 업그레이드 규율

선택한 TypePolicy/profile에서 생성 모델 파일을 파생 아티팩트로 취급하세요.
runtime과 codegen에서 같은 descriptor를 사용하고 metadata나 설정을 바꾼 후
`sqlbraid codegen`을 실행하고 결과를 commit한 다음 `sqlbraid codegen --check`를
실행하세요. direct-vs-pool factory를 소유한 물리 리소스에 맞추세요. Vite
transform과 서버 데이터베이스 runtime을 분리하고 Node 전용 데이터베이스
드라이버를 브라우저 코드로 가져오지 마세요.

[루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/),
[제한 사항](/SQLBraid/release/limitations/), [런타임/드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.

## 과거 PV16 기록

이전 PV16/PV17 구현은 SQLite integer mode를 사용했고 일부 정확한 정수를
`bigint`로 노출했습니다. 당시의 revision별 Runtime, Docs, Release dry-run
link는 provenance를 위해 보존하지만 현재 source나 PV18 profile/container
계약을 인증하지 않습니다.
