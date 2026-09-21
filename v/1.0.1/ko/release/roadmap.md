# 로드맵

> 현재 동작과 별도 설계 및 증거가 필요한 후보를 구분합니다.

## 현재 1.0.0 GA 표면

현재 API에는 SQL 우선 template, 안전한 bind, 동적 `@braid`, result contract,
Standard Schema 매핑, 물리 lease/session 소유권, transaction/savepoint 범위,
capability 기반 cancellation, prepared input/zero-input factory, stream,
observer, metadata, 결정적 codegen, 표준 LSP, CLI JSON 검사, 얇은 VS Code
client, native DML-returning contract, 동종 command bulk, MariaDB, Browser
SQLite WASM, D1, representation-profile contract와 선택적 OpenTelemetry DB
client span 및 duration metric이 포함됩니다.

지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/v/1.0.1/reference/support.md)가
기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별
테스트 버전에만 적용됩니다.

Profile descriptor는 driver option, raw/canonical representation, TypePolicy
provenance를 묶으며 runtime과 codegen은 동일 descriptor를 재사용해야 합니다.
Container 동작은 재귀적으로 추론하지 않습니다. Support label은 revision별,
capability별입니다.

## 향후 후보

현재 API가 아니므로 지원되는 것처럼 production code에 복사하면 안 됩니다.

- 더 넓은 database/server-line 및 추가 first-party driver 증거
- application input mapping과 명시적 codec contract
- 선택적 database verification과 풍부한 SQL 진단
- pipeline/COPY/LOAD DATA, query transformation, routing/retry
- 더 풍부한 container/JSON/temporal representation 증거

Cancellation, session, transaction option, prepared input factory, bulk/stream
지원은 현재 contract이므로 roadmap 후보가 아닙니다. Missing capability는
숨겨진 fallback이 아니라 명시적인 `UnsupportedFeatureError`로 실패합니다.
후보가 Official support claim이 되려면 dialect/driver/runtime 의미, 실행 범위,
package metadata, translation, exact release evidence를 완료해야 합니다.
