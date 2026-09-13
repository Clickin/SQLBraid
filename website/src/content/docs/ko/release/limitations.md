---
title: 현재 제한 사항
description: PV15 프리릴리스 계약이 의도적으로 약속하지 않는 내용을 확인합니다.
---

- **PV15 최종 검증은 대기 중입니다.** 이 문서는 최종 SHA, CI 게이트, 배포 또는 릴리스 label을 주장하지 않으며 역사적 증거는 [지원 매트릭스](/SQLBraid/reference/support/)에서 표시합니다.
- **`db.all()`은 materialized입니다.** readonly 배열을 반환하고 O(row-count) 애플리케이션 메모리를 사용합니다. 메모리를 제한해야 하는 행 쿼리에는 `db.stream()`을 사용하세요.
- **루틴 스트리밍은 포함되지 않습니다.** materialized `db.call()`은 매핑 전에 루틴 리소스를 소비하고 닫으며 다중 cursor session 소유권은 향후 API로 남겨둡니다.
- **MySQL prepared CALL OUT/INOUT은 지원하지 않습니다.** mysql2 3.x public API로 추가 결과가 OUT carrier인지 증명할 수 없으므로 SQLBraid는 추측하지 않습니다.
- **PostgreSQL refcursor 호출은 기존 transaction이 필요합니다.** refcursor는 독립 driver ResultSet이 아닌 transaction-bound portal이며 SQLBraid는 root call을 숨은 transaction으로 감싸지 않습니다.
- **SQL Server cursor output은 애플리케이션 cursor로 지원하지 않습니다.** `CURSOR VARYING OUTPUT`은 T-SQL 언어 기능이지만 일반 client API는 bind 가능한 ResultSet으로 노출하지 않습니다. emitted `SELECT` 행은 일반 result set입니다.
- **SQLite 루틴 호출은 지원하지 않습니다.** SQLite scalar/aggregate/window function은 일반 SQL 안에서 실행되고 virtual-table/table-valued extension은 일반 행 쿼리입니다. `integerMode: "bigint"`는 명시적이며 native statement capability가 필요합니다.
- **Native SQL Server RETURN status에는 명시적 procedure metadata가 필요합니다.** `sql.call({ procedure: { name, parameterNames } })`를 사용하며 임의 `EXEC` 텍스트에서 identity를 추측하지 않습니다.
- **범용 input codec이 없습니다.** 일반 보간은 드라이버에 바인드되며 애플리케이션 JSON, temporal, custom-class, binary 규칙은 드라이버/애플리케이션의 책임입니다.
- **SQL에서 TypeScript 추론을 하지 않습니다.** 임의 SELECT/JOIN 결과 추론과 관계 객체 그래프 hydrate는 계약 밖입니다.
- **격리 API가 없습니다.** 콜백 안에서 애플리케이션이 명시적 SQL을 실행하지 않으면 transaction은 데이터베이스/드라이버 연결 기본값을 사용합니다.
- **Observer mutation/retry/routing이 없습니다.** Observer는 작업을 검사하거나 실패시킬 수 있지만 SQL 재작성, bind 변경, retry는 할 수 없습니다.
- **메타데이터는 무효성의 증거가 아닙니다.** 누락 객체는 open-world이며 루틴 인자 목록은 불완전할 수 있습니다.
- **사용자 지정 드라이버는 릴리스 지원이 아닙니다.** `QueryExecutor`/`ConnectionProvider`를 구현하고 독립 증거를 제공하세요.
- **Tooling은 Node 우선입니다.** compiler, CLI, LSP, metadata/codegen, Vite 통합은 별도 build/runtime 관심사이며 Node 전용 데이터베이스 드라이버를 브라우저 bundle에 넣지 마세요.

이 제한은 숨겨진 fallback이 아닌 의도적인 경계입니다. [루틴 호출](/SQLBraid/concepts/routines/), [스트리밍](/SQLBraid/runtime/streaming/), [로드맵](/SQLBraid/release/roadmap/)을 참고하세요.
