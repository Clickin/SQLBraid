---
title: PV16 릴리스 노트
description: DML returning, bulk, MariaDB, Browser WASM, D1을 포함하는 프리릴리스 표면입니다.
---

구현 revision `2890ef65d15ac96a7e3471911b381340aa30579a`는 Runtime, Docs와
Release dry-run을 통과했습니다. 정확한 프로필과 workflow 링크는
[지원 증거](/SQLBraid/ko/reference/support/#릴리스-증거-출처)에 있습니다.
문서 baseline은 `b5600ebf8a3fed4b80c6f31550a37488ef057525`입니다. npm RC나
stable 발행은 주장하지 않습니다.

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
- 숫자 정확도 helper와 데이터 표현 프로필: 정확한 정수는 `bigint`, 정확한
  10진수는 문자열이며 Oracle `NUMBER`는 text로 유지하고 Tedious
  `decimal`/`numeric`은 정확한 10진수 지원이 아님

## 검증 상태

공유 매니페스트에는 정확히 인증한 8개 프로필과 Compatible인 로컬 D1
binding을 기록합니다. D1의 managed SQLite 버전은 공개되지 않으며 Oracle
Free 23.9가 19c를 인증하지는 않습니다. 증거는 revision별이며 이후 변경은
자체 게이트가 필요합니다. 실제 발행은 생략했고, 사용자 수락과 명시적인
릴리스 승인은 별도입니다.

## 업그레이드 규율

생성 모델 파일을 파생 아티팩트로 취급하세요. metadata나 설정을 바꾼 후
`sqlbraid codegen`을 실행하고 결과를 commit한 다음 `sqlbraid codegen --check`를
실행하세요. direct-vs-pool factory를 소유한 물리 리소스에 맞추세요. Vite
transform과 서버 데이터베이스 runtime을 분리하고 Node 전용 데이터베이스
드라이버를 브라우저 코드로 가져오지 마세요.

[루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/),
[제한 사항](/SQLBraid/release/limitations/), [런타임/드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.
