---
title: 로드맵
description: 현재 동작과 별도 설계 및 증거가 필요한 후보를 구분합니다.
---

## 0.1.0 후보 표면

출시 범위에는 SQL 우선 템플릿, 안전한 바인드, 동적 `@braid`, 결과 계약, Standard Schema 매핑, 물리적 연결 leasing, 트랜잭션/savepoint, stream, observer, metadata v1, 결정적 codegen, 표준 LSP, CLI JSON 대체 수단, 얇은 VS Code client, native DML-returning 계약, 동종 command bulk, MariaDB, Browser SQLite WASM, D1, 명시적 PV18 profile-coherent 값 정확도 계약이 포함됩니다.

PV18은 `2119d9676b05fb2531eaf7aac1ef37741600ba40`에서 시작합니다. 최종
exact-SHA Runtime, Docs, Release dry-run 증거는 대기 중이므로 해당 gate 전에는
[지원 매트릭스](/SQLBraid/reference/support/)가 변경된 프로필을 승격하면
안 됩니다. 인증은 정확한 프로필의 범위이며 미래 버전을 포함하지 않습니다.
RC 발행에는 여전히 사용자 수락과 명시적인 릴리스 승인이 필요합니다.

프로필 descriptor는 driver option, raw/canonical 표현, TypePolicy provenance를
함께 묶으며 codegen은 runtime에서 선택한 descriptor를 재사용해야 합니다.
Container 지원은 의도적으로 재귀적이지 않으므로 일반 scalar/array 증거와
희귀 composite/object/variant/vector 증거를 독립적으로 승격할 수 있습니다.
최종 exact-SHA gate 전에는 RC 준비 상태를 주장하지 않습니다.

## 출시 후 후보

현재 API가 아니며 지원되는 것처럼 프로덕션 코드에 복사해서는 안 됩니다.

- 더 넓은 Oracle/server-line 및 추가 첫 번째 파티 드라이버 증거
- 애플리케이션 input mapping 및 명시적 codec 계약
- 선택적 데이터베이스 검증 및 더 풍부한 SQL 진단
- cancellation, pipeline/COPY/LOAD DATA 작업, 쿼리 변환, routing/retry, OpenTelemetry 통합
- 명시적 격리/세션 동작을 위한 transaction-profile API

후보는 해당 dialect/드라이버/런타임 의미, regression 범위, 패키지 메타데이터, 정확한 릴리스 증거가 독립적으로 완료된 뒤에만 Official 지원 claim이 됩니다. 이 로드맵은 배포나 지원 label을 의미하지 않습니다.

docs-pages workflow는 push에서 자동으로 검증합니다. Pages 배포와 history
업데이트에는 `deploy=true`인 명시적 `workflow_dispatch`가 필요합니다.
