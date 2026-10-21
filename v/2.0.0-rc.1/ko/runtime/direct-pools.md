# 직접 연결과 풀

> 사용하는 물리 데이터베이스 리소스에 맞는 팩토리를 고릅니다.

SQLBraid는 소유권을 명시적으로 다룹니다. 모양만 보고 풀을 판별하지 않습니다.

## 직접 연결 리소스

`@sqlbraid/runtime`의 `createDatabase(executor)`와 각 어댑터의 직접 연결 팩토리는 물리 실행 리소스 하나를 감쌉니다.

- PostgreSQL은 연결된 `pg.Client`나 `pg.PoolClient`를 받습니다.
- MySQL은 `mysql2/promise`의 resolve된 `Connection`이나 `PoolConnection` 객체를 받습니다.
- SQLite는 `DatabaseSync`와 호환되는 리소스를 받습니다.

```ts
const pgDb = createPgDatabase(client);
const mysqlDb = createMysql2Database(connection);
const sqliteDb = createNodeSqliteDatabase(native);
```

소유권 키를 공유하는 직접 연결 래퍼들은 물리 작업을 하나씩 순서대로 실행합니다. 직접 연결 리소스를 닫는 것은 애플리케이션의 몫입니다.

## 풀

명시적인 풀 팩토리를 쓰세요.

```ts
const pgDb = createPgPoolDatabase(pgPool);
const mysqlDb = createMysql2PoolDatabase(mysqlPool);
const mariadbDb = createMariaDbPoolDatabase(mariadbPool);
const customDb = createPooledDatabase(connectionProvider);
```

프로바이더의 `acquire()`는 실행기와 `release({ discard })`를 가진 `ConnectionLease` 하나를 반환합니다. 풀을 쓰는 독립된 루트 작업은 리스 하나를 획득하고, DB I/O를 실행하고, 리스를 반환한 뒤, 메모리로 읽은 결과를 매핑합니다. 풀 종료는 애플리케이션이 맡습니다.

프로바이더는 변경할 수 없는 `statementBinding` 어댑터를 제공합니다. 바인딩 설명과 힌트 검증은 `acquire()` 전에 일어납니다. 모든 리스는 정확히 그 어댑터 객체를 써야 합니다. 리스가 전송 방식이나 방언을 몰래 바꿀 수 없습니다.

풀은 실행기를 흉내 내는 대상이 아닙니다. `BEGIN`, 쿼리, `COMMIT`이 서로 다른 물리 커넥션으로 갈 수 있다면 그 트랜잭션은 진짜가 아닙니다. 리스를 고정하려면 `db.tx(...)`를 쓰세요.

`db.session(async (session) => ...)`은 콜백 동안 획득한 리스 하나를 고정합니다.

- 중첩 세션은 같은 리스를 씁니다.
- 세션 안의 `db.tx(...)`는 다시 획득하지 않습니다.
- 바깥쪽 루트 데이터베이스로 그 범위를 빠져나갈 수 없습니다.
- 스트림은 커서나 요청을 정리할 때까지 리스를 붙잡고 있습니다.
- 프로바이더나 세션 기능이 없으면 `BRAID_SESSION_UNSUPPORTED`로 실패합니다.

이미 중단된 시그널은 원래 `reason`을 유지합니다. 활성 취소는 드라이버 기능입니다. 기능이 없으면 작업은 I/O 전에 `UnsupportedFeatureError` / `BRAID_CANCEL_UNSUPPORTED`로 실패합니다. 트랜잭션 옵션은 획득 전에 검증합니다.

- 형식이 잘못된 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`를 씁니다.
- 올바르지만 지원하지 않는 값은 `BRAID_TX_OPTION_UNSUPPORTED`를 씁니다.
- 중첩 트랜잭션의 명시적 옵션은 `BRAID_TX_OPTIONS_NESTED`를 씁니다.

:::caution 팩토리 경계
`createPgDatabase`에 `pg.Pool`을, `createMysql2Database`에 mysql2 풀을, `createMariaDbDatabase`에 mariadb 풀을 넘기는 것은 지원하지 않습니다. `createPgPoolDatabase`, `createMysql2PoolDatabase`, `createMariaDbPoolDatabase`를 쓰세요.
:::
