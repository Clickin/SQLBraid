---
title: 로드맵
description: 현재 동작과 별도 설계 및 증거가 필요한 후보를 구분합니다.
---

## 현재 프리릴리스 표면

현재 API에는 SQL 우선 template, 안전한 bind, 동적 `@braid`, result contract,
Standard Schema 매핑, 물리 lease/session 소유권, transaction/savepoint 범위,
capability 기반 cancellation, prepared input/zero-input factory, stream,
observer, metadata, 결정적 codegen, 표준 LSP, CLI JSON 검사, 얇은 VS Code
client, native DML-returning contract, 동종 command bulk, MariaDB, Browser
SQLite WASM, D1, representation-profile contract가 포함됩니다.

provenance로 보존하는 마지막 exact-SHA 검증은 revision
`8da8167e027320fcc9bb2aac16b0903c64147940`이며 Runtime
([34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046)),
Documentation ([34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102)),
Release ([34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326))가
성공했습니다. 현재 tree는 더 최신이므로 새로운 exact-SHA gate를 기다리는
pending 상태입니다. 이 link는 현재 지원이나 발행을 의미하지 않습니다.

Profile descriptor는 driver option, raw/canonical representation, TypePolicy
provenance를 묶으며 runtime과 codegen은 동일 descriptor를 재사용해야 합니다.
Container 동작은 재귀적으로 추론하지 않습니다. Support label은 revision별,
capability별입니다.

## 향후 후보

현재 API가 아니므로 지원되는 것처럼 production code에 복사하면 안 됩니다.

- 더 넓은 database/server-line 및 추가 first-party driver 증거
- application input mapping과 명시적 codec contract
- 선택적 database verification과 풍부한 SQL 진단
- pipeline/COPY/LOAD DATA, query transformation, routing/retry, OpenTelemetry
- 더 풍부한 container/JSON/temporal representation 증거

Cancellation, session, transaction option, prepared input factory, bulk/stream
지원은 현재 contract이므로 roadmap 후보가 아닙니다. Missing capability는
숨겨진 fallback이 아니라 명시적인 `UnsupportedFeatureError`로 실패합니다.
후보가 Official support claim이 되려면 dialect/driver/runtime 의미, 실행 범위,
package metadata, translation, exact release evidence를 완료해야 합니다.

Pages 배포와 release history에는 명시적인 승인이 필요합니다. 이 로드맵은
tag, npm 발행 또는 Pages 배포를 의미하지 않습니다.
