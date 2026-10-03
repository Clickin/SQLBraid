---
title: 패키지 맵
description: 각 관심사를 담당하는 SQLBraid 패키지를 찾습니다.
---

| 패키지                      | 책임                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqlbraid`                  | 표준 runtime facade; 결합된 driver+dialect/query subpath는 matching adapter를 사용하며 `/bun-sql`은 명시적 dialect를 받는 multi-dialect adapter |
| `@sqlbraid/core`            | 공개 인터페이스, Standard Schema 대상 타입, 렌더링된 파라미터 메타데이터                                                                        |
| `@sqlbraid/template`        | 태그 템플릿, 지시문, 렌더링, 구조적 조각, `sql.bind`                                                                                            |
| `@sqlbraid/runtime`         | 실행, 매핑, 결과 종류 검사, 트랜잭션, 스트리밍, prepared shape                                                                                  |
| `@sqlbraid/postgres`        | PostgreSQL dialect/TypePolicy; `/pg` 어댑터; `/inspector`                                                                                       |
| `@sqlbraid/mysql`           | MySQL dialect/TypePolicy; `/mysql2` 어댑터; `/inspector`                                                                                        |
| `@sqlbraid/mariadb`         | MariaDB dialect/TypePolicy; `/mariadb` 어댑터; `/inspector`                                                                                     |
| `@sqlbraid/sqlite`          | SQLite dialect; `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, `/d1` 어댑터; `/inspector`                                               |
| `@sqlbraid/oracle`          | Oracle dialect/TypePolicy 및 파라미터 힌트; `/oracledb` 어댑터; `/inspector`                                                                    |
| `@sqlbraid/mssql`           | SQL Server dialect/TypePolicy 및 파라미터 힌트; `/tedious` 어댑터; `/inspector`                                                                 |
| `@sqlbraid/bun-sql`         | 사용자가 PostgreSQL/MySQL/MariaDB/SQLite dialect를 선택하는 Bun.SQL adapter family                                                              |
| `@sqlbraid/compiler`        | TypeScript 검색 및 보호된 템플릿 lowering                                                                                                       |
| `@sqlbraid/vite`            | source map을 보존하는 guarded-template용 Vite 8 pre-transform                                                                                   |
| `@sqlbraid/opentelemetry`   | observer를 통한 선택적 OpenTelemetry DB client span 및 duration metric                                                                          |
| `@sqlbraid/metadata`        | DB 사실 스냅샷, 검증, identity, drift                                                                                                           |
| `@sqlbraid/codegen`         | 메타데이터 + TypePolicy에서 Row/Insert/Update 선언 생성                                                                                         |
| `@sqlbraid/tooling`         | 공유 설정/워크스페이스 증거 및 의미 인덱스                                                                                                      |
| `@sqlbraid/operations`      | fingerprint 및 선언 manifest                                                                                                                    |
| `@sqlbraid/cli`             | codegen, inspect, diagnostics, drift, 명령줄 대체 수단                                                                                          |
| `@sqlbraid/language-server` | 표준 stdio LSP 통합                                                                                                                             |

애플리케이션 코드에는 `sqlbraid`를 설치하세요. 그 다음 driver와 dialect를
결합한 subpath를 사용하세요: `sqlbraid/pg`,
`sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`,
`sqlbraid/tedious`. Bun.SQL에는 여러 dialect를 지원하는 `sqlbraid/bun-sql`
adapter를 사용하세요. 선택한 dialect root에서 `sql`을 import하고 같은
dialect를 명시적으로 전달하세요.

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

`node:sqlite` adapter는 Node에 포함된 모듈을 사용합니다. 별도 driver 패키지가 필요하지 않습니다. 애플리케이션이 사용하는 다른 외부 드라이버는 설치하세요.

루트는 database-neutral입니다. 암묵적인 `sql` tag를 내보내지 않습니다.
dialect-only subpath `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`,
`sqlbraid/oracle`, `sqlbraid/mssql`은 custom adapter용입니다. 세분화된
`@sqlbraid/*` 패키지도 라이브러리 작성자와 의도적으로 좁은 의존성을 위해 계속
지원됩니다.

`sqlbraid/compiled`는 compiler가 생성한 `capture`와 `assertDirectiveCondition`
helper를 위한 고급 진입점입니다. 애플리케이션이 query를 작성하는 API가
아닙니다. compiler를 import하지 않습니다. compiler와 runtime은 같은 버전을
사용하세요.

- `@sqlbraid/bun-sql`은 static Bun import가 없고 명시적인 `dialect`를
  요구합니다. SQL 의미를 자동으로 감지하지 않습니다.
- 런타임 패키지는 metadata, codegen, compiler, editor, Vite 의존성을 가지지
  않습니다. Tooling 패키지는 개발/빌드 환경에만 설치하세요.
- Oracle, SQL Server, MariaDB, Bun 의존성은 portable root에 들어가지 않습니다.
- `@sqlbraid/vite`는 Vite를 peer로 유지하고 framework를 import하지 않습니다.
- `@sqlbraid/opentelemetry`는 `@opentelemetry/api`를 peer로 유지합니다. SDK,
  exporter, logger, driver instrumentation, database driver를 설치하지 않습니다.

동기식 SQLite adapter는 물리 SPI `Awaitable<T>`를 사용합니다. public
`Database` method는 async로 유지됩니다.

- better-sqlite3는 여전히 event loop를 block합니다. statement별 설정으로 exact
  integer를 읽습니다.
- libSQL은 `{ intMode: "string" }`를 요구하고 interactive transaction handle을
  사용합니다. `session.pinned`를 주장하지 않습니다. buffering하지 않고
  `BRAID_STREAM_UNSUPPORTED`를 반환합니다.

이것은 transport/capability 경계입니다. 광범위한 support label이 아닙니다.

- `db.session()`은 provider lease 하나를 고정합니다. `db.tx()`는 그 lease를
  재사용합니다. 선택한 adapter가 advertise할 때만 savepoint/option을
  지원합니다.
- Prepared query는 물리 placeholder가 아니라 logical shape를 lock합니다.
- Active cancellation은 capability에 따릅니다. capability가 없으면
  `BRAID_CANCEL_UNSUPPORTED`로 실패합니다.
- Bun 1.3.14는 PostgreSQL/MySQL/MariaDB에 `{ bigint: true }`를, SQLite에
  `{ safeIntegers: true }`를 사용합니다. column metadata가 없습니다. 따라서
  integral `Number` row와 integral-approximate `Number` row를 ambiguous로
  거부합니다.
- PostgreSQL decimal은 text입니다. MySQL/MariaDB DECIMAL과 binary byte
  carrier는 SQL에서 text/hex로 변환하지 않으면 거부됩니다.
- SQLite native decimal은 unsupported입니다.
- Bun에서 MySQL/MariaDB의 빈 `SELECT`와 영향 행이 0인 DML/DDL은
  `bun-sql.result-kind-metadata` guarded 조건을 사용합니다. 실행 후
  `BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있습니다.

Bun.SQL MySQL/MariaDB는 명시적인 `readOnly: true`와 `readOnly: false`도 I/O
전에 거부합니다(`BRAID_TX_OPTION_UNSUPPORTED`, `transaction.read-only`).
option을 생략하면 native session 기본값이 유지됩니다. Bun.SQL PostgreSQL의
access mode는 바뀌지 않습니다. [Transaction option 경계](/SQLBraid/runtime/transaction-profiles/)를
참고하세요.

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
