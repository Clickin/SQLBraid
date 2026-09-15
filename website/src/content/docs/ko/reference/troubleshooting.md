---
title: 문제 해결
description: 가장 흔한 설정 및 런타임 경계 실수를 해결합니다.
---

## `BRAID_RESULT_KIND`

SQL 텍스트는 실행되었지만 선언한 태그가 어댑터의 실제 행/command 결과와 일치하지 않습니다. 행을 생성하는 문에는 `sql.rows`, 쓰기에는 `sql.command`, 결과가 의도적으로 드라이버에 의존하면 unknown 쿼리와 함께 `db.execute`를 사용하세요. 잘못된 선언에서 쓰기를 rollback해야 한다면 트랜잭션을 사용하세요.

## `BRAID_TX_SCOPE` 또는 `BRAID_TX_CLOSED`

`db.tx` 안의 모든 작업에는 `tx` 콜백 핸들을 사용하세요. 자신의 콜백에서 외부 `db`를 호출하지 말고 콜백이 반환된 뒤 `tx`를 보존하지도 마세요. 중첩 트랜잭션에는 가장 안쪽 savepoint 핸들이 필요합니다.

## 풀이 잘못된 연결을 사용함

직접 어댑터 팩토리에 풀을 전달하지 마세요. `createPgPoolDatabase`, `createMysql2PoolDatabase`, 또는 `createMariaDbPoolDatabase`를 사용하고, 여러 문장이 하나의 물리적 연결을 공유해야 할 때는 `db.tx`를 사용하세요.

## `sql.list([])` 실패

빈 목록은 보편적인 SQL 의미가 없습니다. `@braid if`로 조건을 보호하거나 애플리케이션을 위한 의도적인 false predicate를 선택하세요.

## Codegen이 stale이라고 표시함

Inspector가 메타데이터 스냅샷을 만들고 생성 모델은 파생됩니다. 메타데이터/설정을 바꾼 뒤 `sqlbraid codegen`을 실행하고 `sqlbraid codegen --check`를 CI에 유지하세요. 생성 출력은 절대 직접 수정하지 마세요.

## LSP에 completion이 없음

Completion은 정적 SQL에 대한 메타데이터 증거일 뿐입니다. TypeScript 보간 표현식 내부는 추론하지 않으며, 누락된 메타데이터는 데이터베이스 객체가 유효하지 않다는 증거가 아닙니다. 프로젝트 설정이 검색되는지와 메타데이터 스냅샷이 검증되는지 확인하세요.

## SQLite 루틴 호출 또는 stream 실패

SQLite 어댑터는 `BRAID_CALL_UNSUPPORTED`를 보고합니다. 스트리밍에는 네이티브 문의 iteration protocol이 필요하며, 그렇지 않으면 `BRAID_STREAM_UNSUPPORTED`를 보고합니다.
