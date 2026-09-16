---
title: 패키지 맵
description: 각 관심사를 담당하는 SQLBraid 패키지를 찾습니다.
---

| 패키지 | 책임 |
| --- | --- |
| `sqlbraid` | 표준 runtime facade; 결합된 driver+dialect/query subpath는 matching adapter를 사용하며 `/bun-sql`은 명시적 dialect를 받는 multi-dialect adapter |
| `@sqlbraid/core` | 공개 계약, Standard Schema 대상 타입, 렌더링된 파라미터 메타데이터 |
| `@sqlbraid/template` | 태그 템플릿, 지시문, 렌더링, 구조적 조각, `sql.bind` |
| `@sqlbraid/runtime` | 실행, 매핑, 결과 종류 검사, 트랜잭션, 스트리밍, prepared shape |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` 어댑터; `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` 어댑터; `/inspector` |
| `@sqlbraid/mariadb` | MariaDB dialect/TypePolicy; `/mariadb` 어댑터 |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, `/d1` 어댑터; `/inspector` |
| `@sqlbraid/oracle` | Oracle dialect/TypePolicy 및 파라미터 힌트; `/oracledb` 어댑터; `/inspector` |
| `@sqlbraid/mssql` | SQL Server dialect/TypePolicy 및 파라미터 힌트; `/tedious` 어댑터; `/inspector` |
| `@sqlbraid/bun-sql` | 사용자가 PostgreSQL/MySQL/MariaDB/SQLite dialect를 선택하는 Bun.SQL adapter family |
| `@sqlbraid/compiler` | TypeScript 검색 및 보호된 템플릿 lowering |
| `@sqlbraid/vite` | source map을 보존하는 guarded-template용 Vite 8 pre-transform |
| `@sqlbraid/opentelemetry` | observer를 통한 선택적 OpenTelemetry DB client span 및 duration metric |
| `@sqlbraid/metadata` | DB 사실 스냅샷, 검증, identity, drift |
| `@sqlbraid/codegen` | 메타데이터 + TypePolicy에서 Row/Insert/Update 선언 생성 |
| `@sqlbraid/tooling` | 공유 설정/워크스페이스 증거 및 의미 인덱스 |
| `@sqlbraid/operations` | fingerprint 및 선언 manifest |
| `@sqlbraid/cli` | codegen, inspect, diagnostics, drift, 명령줄 대체 수단 |
| `@sqlbraid/language-server` | 표준 stdio LSP 통합 |

애플리케이션 코드는 `sqlbraid`를 설치한 뒤 결합된 driver+dialect/query
subpath인 `sqlbraid/pg`,
`sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`,
`sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`,
`sqlbraid/tedious`를 사용합니다. Bun.SQL은 multi-dialect
`sqlbraid/bun-sql` adapter를 사용하며, 선택한 dialect root에서 `sql`을
가져오고 같은 dialect를 명시적으로 전달합니다.

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

루트는 database-neutral이며 암묵적인 `sql` tag를 내보내지 않습니다.
`sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`,
`sqlbraid/oracle`, `sqlbraid/mssql` dialect-only subpath는 custom adapter용이며
세분화된 `@sqlbraid/*` 패키지도 계속 지원합니다. `@sqlbraid/bun-sql`은 static
Bun import가 없고 명시적인 `dialect`를 요구하며 SQL 의미를 자동 감지하지
않습니다. 런타임 패키지는 metadata, codegen, compiler, editor 또는 Vite
의존성을 가져오지 않습니다. Tooling은 개발/빌드 환경에만 설치하세요. Oracle,
SQL Server, MariaDB, Bun driver 의존성은 portable root에서 제외됩니다.
`@sqlbraid/vite`는 Vite를 peer로 유지하며 framework를 가져오지 않습니다.
`@sqlbraid/opentelemetry`는 `@opentelemetry/api`를 peer로 유지하며 SDK,
exporter, logger, driver instrumentation 또는 database driver를 설치하지
않습니다.

동기식 SQLite adapter는 public `Database` method를 async로 유지하면서
물리 `Awaitable<T>` SPI를 사용합니다. better-sqlite3는 event loop를 계속
block하며 statement-local exact integer read를 사용합니다. libSQL은
`{ intMode: "string" }`를 요구하고 interactive transaction handle을
사용하며 `session.pinned`를 주장하지 않습니다. Buffering하는 대신
`BRAID_STREAM_UNSUPPORTED`를 반환합니다. 이는 transport/capability 경계이지
광범위한 support label이 아닙니다.

동기식 SQLite adapter는 public `Database` method를 async로 유지하면서
물리 `Awaitable<T>` SPI를 사용합니다. better-sqlite3는 event loop를 계속
block하며 statement-local exact integer read를 사용합니다. libSQL은
`{ intMode: "string" }`를 요구하고 interactive transaction handle을
사용하며 `session.pinned`를 주장하지 않습니다. Buffering하는 대신
`BRAID_STREAM_UNSUPPORTED`를 반환합니다. 이는 transport/capability 경계이지
광범위한 support label이 아닙니다.

`db.session()`은 하나의 provider lease를 고정하고 `db.tx()`는 이를
재사용하며 선택한 adapter가 advertise하는 경우에만 savepoint/option을
지원합니다. Prepared query는 물리 placeholder가 아닌 logical shape를
lock합니다. Active cancellation은 capability 기반이며 없으면
`BRAID_CANCEL_UNSUPPORTED`로 실패합니다. Bun 1.3.14는
PostgreSQL/MySQL/MariaDB에 `{ bigint: true }`, SQLite에
`{ safeIntegers: true }`를 사용하며 column metadata가 없어 integral 또는
integral-approximate `Number` row를 ambiguous로 거부합니다. PostgreSQL decimal은
text이며 MySQL/MariaDB DECIMAL과 binary byte carrier는 직접 작성한 SQL
text/hex 변환 없이 거부됩니다. SQLite native decimal은 unsupported입니다.
Bun MySQL/MariaDB의 빈 `SELECT`와
영향 행 0인 DML/DDL은 `bun-sql.result-kind-metadata` 조건에서 guarded되며
실행 후 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있습니다.

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
