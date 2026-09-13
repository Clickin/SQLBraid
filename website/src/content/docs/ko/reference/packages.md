---
title: 패키지 맵
description: 각 관심사를 담당하는 SQLBraid 패키지를 찾습니다.
---

| 패키지 | 책임 |
| --- | --- |
| `@sqlbraid/core` | 공개 계약, Standard Schema 대상 타입, 렌더링된 파라미터 메타데이터 |
| `@sqlbraid/template` | 태그 템플릿, 지시문, 렌더링, 구조적 조각, `sql.bind` |
| `@sqlbraid/runtime` | 실행, 매핑, 결과 종류 검사, 트랜잭션, 스트리밍, prepared shape |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` 어댑터; `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` 어댑터; `/inspector` |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite` 어댑터; `/inspector` |
| `@sqlbraid/oracle` | Oracle dialect/TypePolicy 및 파라미터 힌트; `/oracledb` 어댑터; `/inspector` |
| `@sqlbraid/mssql` | SQL Server dialect/TypePolicy 및 파라미터 힌트; `/tedious` 어댑터; `/inspector` |
| `@sqlbraid/compiler` | TypeScript 검색 및 보호된 템플릿 lowering |
| `@sqlbraid/vite` | source map을 보존하는 guarded-template용 Vite 8 pre-transform |
| `@sqlbraid/metadata` | DB 사실 스냅샷, 검증, identity, drift |
| `@sqlbraid/codegen` | 메타데이터 + TypePolicy에서 Row/Insert/Update 선언 생성 |
| `@sqlbraid/tooling` | 공유 설정/워크스페이스 증거 및 의미 인덱스 |
| `@sqlbraid/operations` | fingerprint 및 선언 manifest |
| `@sqlbraid/cli` | codegen, inspect, diagnostics, drift, 명령줄 대체 수단 |
| `@sqlbraid/language-server` | 표준 stdio LSP 통합 |
| `sqlbraid` | 비스코프 CLI 편의 패키지; 데이터베이스 드라이버 없이 `sqlbraid` 실행 파일 제공 |

패키지는 17개입니다. 스코프가 있는 런타임/도구 패키지 16개와 비스코프 CLI 편의 패키지 1개입니다. 런타임 패키지는 메타데이터, codegen, compiler, editor 또는 Vite 의존성을 가져오지 않습니다. tooling 패키지는 개발/빌드 환경에만 설치하세요. Oracle 및 SQL Server 드라이버 의존성은 portable root에서 제외됩니다. `@sqlbraid/vite`는 Vite를 peer로 유지하며 framework를 가져오지 않습니다.

의존성 방향은 다음과 같습니다.

```text
core / compiler / metadata / codegen
                 ↓
          tooling / vite
             ↙     ↘
           CLI      LSP
                      ↑
                VS Code client
```
