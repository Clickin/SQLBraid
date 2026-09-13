---
title: PV15 릴리스 노트
description: 스트리밍, 루틴 채널, Vite 통합을 포함하는 프리릴리스 표면입니다.
---

PV15 문서는 프리릴리스 SQLBraid 표면을 설명합니다. 최종 검증은 대기 중이며
이 노트는 최종 SHA, CI, 배포 또는 Official 지원 주장을 하지 않습니다.

## 포함된 계약

- PostgreSQL, MySQL, SQLite, Oracle Thin, SQL Server/Tedious dialect 및 어댑터 경로와 명시적인 direct/pool 소유권 경계
- `sql.rows`, `sql.command`, `sql.call`, 안전한 value bind, 구조적 fragment, 동적 `@braid` 지시문
- `all()` buffer가 아닌 실제 드라이버 경로인 `db.stream()`과 물리적 lease 반환 전 어댑터별 정리
- 행과 이질적인 루틴 result-set tuple의 Standard Schema 매핑
- scalar `output`, 순서가 있는 `resultSets`, 선택적 `returnValue` 루틴 채널과 `sql.out`/`sql.inOut` 방향 helper
- PostgreSQL transaction-bound refcursor, Oracle explicit/implicit cursor result, native RETURN status용 SQL Server 명시적 procedure metadata, 의도적인 SQLite 루틴 거부
- MySQL raw prepared `Execute.stream()` 및 검증된 carrier discriminator가 없는 OUT/INOUT의 명시적 거부
- `durationMs`, 민감하지 않은 call result 구조, lazy diagnostic literalization을 포함하는 execution observer
- TypeScript와 framework 변환을 Vite에 맡기고 TSX와 source-map 조합을 보존하는 `@sqlbraid/vite` Vite 8 pre-transform
- 선택적 metadata, inspector, 결정적 codegen, CLI JSON inspection, 표준 stdio LSP, 얇은 VS Code 통합

## 검증 상태

Main이 PV15 최종 검증을 소유합니다. 해당 증거가 제공되기 전에는 지원
매트릭스를 Pending으로, 역사적 exact-SHA 링크를 provenance로만 취급하세요.
이 사이트나 package README에서 배포 또는 릴리스 게이트 완료를 추론하지
마세요.

## 업그레이드 규율

생성 모델 파일을 파생 아티팩트로 취급하세요. metadata나 설정을 바꾼 후
`sqlbraid codegen`을 실행하고 결과를 commit한 다음 `sqlbraid codegen --check`를
실행하세요. direct-vs-pool factory를 소유한 물리 리소스에 맞추세요. Vite
transform과 서버 데이터베이스 runtime을 분리하고 Node 전용 데이터베이스
드라이버를 브라우저 코드로 가져오지 마세요.

[루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/),
[제한 사항](/SQLBraid/release/limitations/), [런타임/드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.
