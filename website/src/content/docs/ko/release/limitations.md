---
title: 현재 제한 사항
description: 0.1.0이 의도적으로 약속하지 않는 내용을 확인합니다.
---

- **Oracle 또는 SQL Server 어댑터가 없습니다.** Oracle/node-oracledb에는 named 및 IN/OUT bind, cursor, LOB, NUMBER와 temporal 표현, object type, result set, pool 의미에 대한 별도 설계가 필요합니다.
- **범용 input codec이 없습니다.** 일반 값 보간은 드라이버에 바인드되며, 애플리케이션 JSON, temporal, custom-class, binary 규칙은 드라이버/애플리케이션의 책임입니다.
- **SQL에서 TypeScript 추론을 하지 않습니다.** 임의 SELECT/JOIN 결과 추론과 관계 객체 그래프 hydrate는 계약 밖입니다.
- **격리 API가 없습니다.** 애플리케이션이 콜백 안에서 명시적 데이터베이스 SQL을 실행하지 않는 한 트랜잭션은 데이터베이스/드라이버 연결 기본값을 사용합니다.
- **Observer mutation/retry/routing이 없습니다.** Observer는 작업을 검사하거나 실패시킬 수 있지만 SQL 재작성, 바인드 변경, retry는 할 수 없습니다.
- **메타데이터는 무효성의 증거가 아닙니다.** 누락된 객체는 개방 세계이며 루틴 인자 목록은 불완전할 수 있습니다.
- **SQLite 루틴 호출은 지원되지 않습니다.** 스트리밍에는 네이티브 문 순회가 필요합니다.
- **사용자 지정 드라이버는 공식 지원이 아닙니다.** `QueryExecutor`/`ConnectionProvider`를 구현하고 독립적인 증거를 제공하세요.
- **Tooling은 Node 우선입니다.** 런타임 패키지가 이식 가능하더라도 compiler, CLI, LSP, metadata/codegen 도구에는 Node 릴리스 환경이 필요합니다.

이 제한은 숨겨진 fallback 동작이 아니라 의도적인 릴리스 경계입니다. 출시 후 후보는 [로드맵](/SQLBraid/release/roadmap/)을 참고하세요.
