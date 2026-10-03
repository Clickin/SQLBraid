---
title: 로드맵
description: 현재 동작과, 별도 설계 및 증거가 필요한 후보를 구분합니다.
---

## 현재 1.0.0 GA 표면

현재 API에는 다음이 포함됩니다.

- SQL 우선 template, 안전한 bind, 동적 `@braid`
- result 선언과 Standard Schema 매핑
- 물리 lease/session 소유권
- transaction/savepoint 범위
- capability에 따른 cancellation
- input이 있거나 없는 prepared factory
- stream과 observer
- metadata, 결정적 codegen, 표준 LSP, CLI JSON 검사, 얇은 VS Code client
- native DML-returning 선언과 동종 command bulk
- MariaDB, Browser SQLite WASM, D1
- representation-profile 규칙
- 선택적 OpenTelemetry DB client span과 duration metric

[런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)는 정확한
database, driver, profile, runtime, capability tuple별 지원 label을 테스트한
버전과 함께 기록합니다.

Profile descriptor는 driver option, raw/canonical representation, TypePolicy
provenance를 묶습니다. runtime과 codegen은 같은 descriptor를 사용해야 합니다.
Container 동작은 재귀적으로 추론하지 않습니다. Support label은 revision별이며
capability에 따릅니다.

## 향후 후보

다음은 현재 API가 아닙니다. 지원되는 것처럼 production code에 복사하지 마세요.

- 더 많은 database/server line과 추가 first-party driver의 증거
- application input mapping과 명시적 codec 규칙
- 선택적 database verification과 더 풍부한 SQL 진단
- pipeline/COPY/LOAD DATA 작업, query transformation, routing/retry
- 더 풍부한 container/JSON/temporal representation 증거

Cancellation, session, transaction option, prepared input factory, bulk/stream
지원은 현재 기능입니다. roadmap 후보가 아닙니다. 없는 capability는 명시적인
`UnsupportedFeatureError`로 실패합니다. 숨겨진 fallback은 없습니다. 후보가
Official support claim이 되려면 다음이 완료되어야 합니다: dialect/driver/runtime
의미, 실행 범위, package metadata, translation, exact release evidence.
