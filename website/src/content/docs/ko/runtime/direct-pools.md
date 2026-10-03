---
title: 직접 연결과 풀
description: 물리적 데이터베이스 리소스에 맞는 팩토리를 선택합니다.
---

SQLBraid는 소유권을 명시적으로 만듭니다. duck typing으로 풀을 감지하지 않습니다.

## 직접 리소스

`@sqlbraid/runtime`의 `createDatabase(executor)`와 어댑터별 직접 팩토리는 물리적 실행 리소스 하나를 감쌉니다.

- PostgreSQL은 연결된 `pg.Client`나 `pg.PoolClient`를 받습니다.
- MySQL은 `mysql2/promise`의 해결된 `Connection`이나 `PoolConnection` 객체를 받습니다.
- SQLite는 `DatabaseSync` 호환 리소스를 받습니다.

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
const mariadbDb = createMariaDbPoolDatabase(mariadbPool);
const customDb = createPooledDatabase(connectionProvider);
```

Provider의 `acquire()`는 executor와 `release({ discard })`가 있는 `ConnectionLease` 하나를 반환합니다. 독립적인 풀 루트 작업은 각각 lease 하나를 얻고, DB I/O를 수행하고, lease를 반환한 뒤 구체화된 결과를 매핑합니다. 풀 종료는 애플리케이션이 소유합니다.

Provider는 불변 `statementBinding` 어댑터를 노출합니다. 바인딩 설명과 힌트
검증은 `acquire()` 전에 수행됩니다. 모든 lease는 정확히 같은 어댑터 객체를
사용해야 합니다. lease는 전송이나 dialect identity를 조용히 바꿀 수 없습니다.

풀은 가짜 executor가 아닙니다. `BEGIN`, 쿼리, `COMMIT`이 서로 다른 물리적 연결로 갈 수 있다면 그 트랜잭션은 실제 트랜잭션이 아닙니다. lease를 고정하려면 `db.tx(...)`를 사용하세요.

`db.session(async (session) => ...)`은 callback 동안 획득한 lease 하나를
고정합니다.

- 중첩 session은 같은 lease를 사용합니다.
- session 안의 `db.tx(...)`는 다시 획득하지 않습니다.
- 바깥 root database로 이 범위를 빠져나갈 수 없습니다.
- Stream은 cursor/request cleanup까지 lease를 유지합니다.
- Provider/session primitive를 사용할 수 없으면 `BRAID_SESSION_UNSUPPORTED`로
  실패합니다.

이미 abort된 signal은 자신의 `reason`을 유지합니다. 활성 cancellation은 driver
capability입니다. 없으면 작업은 I/O 전에 `UnsupportedFeatureError` /
`BRAID_CANCEL_UNSUPPORTED`로 실패합니다. Transaction option은 acquire 전에
검증됩니다.

- 잘못된 형식의 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`를 사용합니다.
- 유효하지만 지원하지 않는 값은 `BRAID_TX_OPTION_UNSUPPORTED`를 사용합니다.
- 중첩 명시 option은 `BRAID_TX_OPTIONS_NESTED`를 사용합니다.

:::caution 팩토리 경계

다음 호출은 지원되지 않습니다: `pg.Pool`을 `createPgDatabase`에, mysql2 풀을 `createMysql2Database`에, mariadb 풀을 `createMariaDbDatabase`에 전달. `createPgPoolDatabase`, `createMysql2PoolDatabase`, `createMariaDbPoolDatabase`를 사용하세요.
