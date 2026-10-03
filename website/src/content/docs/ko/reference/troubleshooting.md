---
title: 문제 해결
description: 설정과 런타임 경계에서 자주 하는 실수를 바로잡습니다.
---

## `BRAID_RESULT_KIND`

SQL 텍스트는 실행되었지만, 선언한 태그가 어댑터가 보고한 실제 결과(행 또는 명령)와 맞지 않았습니다.

- 행을 만드는 문장에는 `sql.rows`를 쓰세요.
- 쓰기에는 `sql.command`를 쓰세요.
- 결과가 일부러 드라이버에 따라 달라진다면 unknown 쿼리와 `db.execute`를 쓰세요.
- 선언이 틀렸을 때 쓰기를 롤백해야 한다면 트랜잭션을 쓰세요.

## `BRAID_TX_SCOPE` 또는 `BRAID_TX_CLOSED`

`db.tx` 안에서는 모든 작업에 콜백 핸들 `tx`를 쓰세요. 콜백 안에서 바깥쪽 `db`를 호출하지 마세요. 콜백이 반환된 뒤에는 `tx`를 계속 쓰지 마세요. 중첩 트랜잭션에서는 가장 안쪽 세이브포인트 핸들을 써야 합니다.

## 풀 작업이 엉뚱한 커넥션을 씁니다

직접 연결 어댑터 팩토리에 풀을 넘기지 마세요. `createPgPoolDatabase`, `createMysql2PoolDatabase`, `createMariaDbPoolDatabase`를 쓰세요. 여러 문장이 물리 커넥션 하나를 공유해야 한다면 `db.tx`를 쓰세요.

## `sql.list([])`가 실패합니다

빈 목록에는 모든 경우에 통하는 SQL 의미가 없습니다. 조건을 `@braid if`로 감싸거나, 애플리케이션에 맞게 항상 거짓인 조건을 직접 고르세요.

## codegen이 stale이라고 합니다

인스펙터가 메타데이터 스냅샷을 만들고, 생성된 모델은 그 스냅샷에서 파생됩니다. 메타데이터나 설정을 바꾼 뒤에는 `sqlbraid codegen`을 실행하세요. CI에는 `sqlbraid codegen --check`를 두세요. 생성된 출력을 직접 고치지 마세요.

## LSP 자동 완성이 나오지 않습니다

자동 완성은 정적 SQL에서만 메타데이터 근거를 제공합니다. TypeScript 보간식 안에서는 추론하지 않습니다. 메타데이터에 없다고 데이터베이스 객체가 잘못되었다는 뜻은 아닙니다. 프로젝트 설정 파일을 찾을 수 있는지, 메타데이터 스냅샷이 유효한지 확인하세요.

## SQLite 루틴 호출이나 스트림이 실패합니다

SQLite 어댑터는 루틴 호출에 `BRAID_CALL_UNSUPPORTED`를 보고합니다. 스트리밍에는 네이티브 문장의 반복 프로토콜이 필요하며, 없으면 어댑터가 `BRAID_STREAM_UNSUPPORTED`를 보고합니다.
