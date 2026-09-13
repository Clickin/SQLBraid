---
title: 직접 연결과 풀
description: 물리적 데이터베이스 리소스에 맞는 팩토리를 선택합니다.
---

SQLBraid는 duck typing으로 풀을 감지하는 대신 소유권을 명시적으로 만듭니다.

## 직접 리소스

`@sqlbraid/runtime`의 `createDatabase(executor)`와 어댑터별 직접 팩토리는 하나의 물리적 실행 리소스를 감쌉니다. PostgreSQL은 연결된 `pg.Client` 또는 `pg.PoolClient`를 받고, MySQL은 `mysql2/promise`의 해결된 `Connection` 또는 `PoolConnection` 객체를 받으며, SQLite는 `DatabaseSync` 호환 리소스를 받습니다.

```ts
const db = createPgDatabase(client);
const db = createMysql2Database(connection);
const db = createNodeSqliteDatabase(native);
```

소유권 키를 공유하는 직접 wrapper는 물리 작업을 직렬화합니다. 직접 리소스 종료는 애플리케이션이 담당합니다.

## 풀

명시적인 풀 팩토리를 사용하세요.

```ts
const pgDb = createPgPoolDatabase(pgPool);
const mysqlDb = createMysql2PoolDatabase(mysqlPool);
const customDb = createPooledDatabase(connectionProvider);
```

Provider의 `acquire()`는 executor와 `release({ discard })`가 있는 `ConnectionLease` 하나를 반환합니다. 독립적인 각 풀 루트 작업은 lease 하나를 얻어 DB I/O를 수행하고 반환한 뒤 구체화된 결과를 매핑합니다. 풀 종료는 애플리케이션이 소유합니다.

Provider는 불변 `statementBinding` 어댑터를 노출합니다. 바인딩 설명과 힌트
검증은 `acquire()` 전에 수행하며, 모든 lease는 정확히 같은 어댑터 객체를
사용해야 합니다. lease가 전송이나 dialect identity를 조용히 바꾸면 안 됩니다.

풀은 가짜 executor가 아닙니다. `BEGIN`, 쿼리, `COMMIT`이 서로 다른 물리적 연결에 도착할 수 있다면 트랜잭션은 실제 트랜잭션이 아닙니다. lease를 고정하려면 `db.tx(...)`를 사용하세요.

:::caution 팩토리 경계
`pg.Pool`을 `createPgDatabase`에 전달하거나 mysql2 풀을 `createMysql2Database`에 전달하는 것은 지원되지 않습니다. `createPgPoolDatabase` 또는 `createMysql2PoolDatabase`를 사용하세요.
:::
