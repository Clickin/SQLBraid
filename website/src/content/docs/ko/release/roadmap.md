---
title: 로드맵
description: 출시된 동작과 별도 설계 및 증거가 필요한 후보를 구분합니다.
---

## 0.1.0에 출시됨

출시 범위에는 SQL 우선 템플릿, 안전한 바인드, 동적 `@braid`, 결과 계약, Standard Schema 매핑, 물리적 연결 leasing, 트랜잭션/savepoint, stream, observer, metadata v1, 결정적 codegen, 표준 LSP, CLI JSON 대체 수단, 얇은 VS Code client가 포함됩니다.

## 출시 후 후보

현재 API가 아니며 지원되는 것처럼 프로덕션 코드에 복사해서는 안 됩니다.

- Oracle/node-oracledb 및 추가 첫 번째 파티 드라이버
- 애플리케이션 input mapping 및 명시적 codec 계약
- 선택적 데이터베이스 검증 및 더 풍부한 SQL 진단
- cancellation, bulk/pipeline 작업, 쿼리 변환, routing/retry, OpenTelemetry 통합
- 명시적 격리/세션 동작을 위한 transaction-profile API

후보는 해당 dialect/드라이버/런타임 의미, regression 범위, 패키지 메타데이터, 릴리스 증거가 독립적으로 완료된 뒤에만 공개됩니다. 출시가 Oracle, SQL Server 또는 일반 transaction profile을 약속하는 것은 아닙니다.
