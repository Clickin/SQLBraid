---
title: 0.1.0 릴리스 노트
description: 9월 출시를 위해 제공되는 SQL 우선 사전 릴리스 범위입니다.
---

SQLBraid 0.1.0은 안정적인 SQL 우선 TypeScript 계약에 집중하는 공개 사전 릴리스입니다.

## 포함된 내용

- 첫 번째 파티 `pg`, `mysql2`, `node:sqlite` 어댑터를 포함한 PostgreSQL, MySQL, SQLite dialect
- 안전한 바인드, 명시적인 `rows`/`command`/`call` 결과 종류, 구조적 조각, 동적 `@braid` 지시문
- Standard Schema 쿼리 연결 및 실행 수준 행 매핑
- 물리적 연결 lease를 사용하는 직접 및 풀 실행
- 트랜잭션, savepoint, 스트리밍, 준비된 shape lock, 실행 observer
- 선택적 metadata v1 스냅샷, inspector, 결정적 Row/Insert/Update codegen, `codegen --check`
- 표준 stdio LSP, CLI JSON 검사, 이식 가능한 에이전트 skill, 얇은 VS Code 통합
- Node 22.18.0 출시 대상과 지원되는 경우 문서화된 Bun/Deno 증거

## 업그레이드 규율

생성 모델 파일을 파생 아티팩트로 취급하세요. 메타데이터나 설정을 바꾼 후 `sqlbraid codegen`을 실행하고 결과를 commit한 다음 `sqlbraid codegen --check`를 실행하세요. 어댑터의 직접-vs-풀 팩토리를 소유한 물리 리소스에 맞추세요.

이 사이트는 `https://clickin.github.io/SQLBraid/`를 의도한 문서 대상으로 삼습니다. 대상 URL은 배포 또는 모든 릴리스 게이트가 완료되었다는 주장이 아닙니다.
