# 패키지 구성

> 각 역할을 맡는 SQLBraid 패키지를 찾습니다.

| 패키지                      | 역할                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sqlbraid`                  | 대표 런타임 파사드. 드라이버+방언 결합 하위 경로는 해당 어댑터를 쓰고, `/bun-sql`은 방언을 명시해야 하는 다중 방언 어댑터 |
| `@sqlbraid/core`            | 공개 인터페이스, Standard Schema 관련 타입, 렌더링된 파라미터 메타데이터                                                  |
| `@sqlbraid/template`        | 태그 템플릿, 지시어, 렌더링, 구조적 조각, `sql.bind`                                                                      |
| `@sqlbraid/runtime`         | 실행, 매핑, 결과 종류 검사, 트랜잭션, 스트리밍, 준비된 쿼리의 형태                                                        |
| `@sqlbraid/postgres`        | PostgreSQL 방언·TypePolicy, `/pg` 어댑터, `/inspector`                                                                    |
| `@sqlbraid/mysql`           | MySQL 방언·TypePolicy, `/mysql2` 어댑터, `/inspector`                                                                     |
| `@sqlbraid/sqlite`          | SQLite 방언, `/node-sqlite`, `/better-sqlite3`, `/libsql`, `/wasm`, `/d1` 어댑터, `/inspector`                            |
| `@sqlbraid/mariadb`         | MariaDB 방언·TypePolicy, `/mariadb` 어댑터, `/inspector`                                                                  |
| `@sqlbraid/bun-sql`         | 사용자가 PostgreSQL/MySQL/MariaDB/SQLite 방언을 반드시 골라야 하는 Bun.SQL 어댑터 계열                                    |
| `@sqlbraid/oracle`          | Oracle 방언·TypePolicy와 파라미터 힌트, `/oracledb` 어댑터, `/inspector`                                                  |
| `@sqlbraid/mssql`           | SQL Server 방언·TypePolicy와 파라미터 힌트, `/tedious` 어댑터, `/inspector`                                               |
| `@sqlbraid/compiler`        | TypeScript 소스 탐색과 조건부 템플릿 변환                                                                                 |
| `@sqlbraid/vite`            | 소스 맵을 유지하며 조건부 템플릿을 변환하는 Vite 8 사전 변환                                                              |
| `@sqlbraid/opentelemetry`   | 옵저버를 통한 선택 사항 OpenTelemetry DB 클라이언트 span과 실행 시간 지표                                                 |
| `@sqlbraid/metadata`        | DB 정보 스냅샷, 검증, 식별, 변경 비교                                                                                     |
| `@sqlbraid/codegen`         | 메타데이터와 TypePolicy로 Row/Insert/Update 선언 생성                                                                     |
| `@sqlbraid/tooling`         | 공유 설정·워크스페이스 근거와 의미 인덱스                                                                                 |
| `@sqlbraid/operations`      | 지문(fingerprint)과 선언 매니페스트                                                                                       |
| `@sqlbraid/cli`             | 선택 사항인 코드 생성, 검사, 진단, 변경 비교, 명령줄 도구                                                                 |
| `@sqlbraid/language-server` | 표준 stdio LSP 연동                                                                                                       |

애플리케이션 코드에는 `sqlbraid`를 설치하세요. 그리고 드라이버와 방언을 묶은 하위 경로를 쓰세요. `sqlbraid/pg`, `sqlbraid/mysql2`, `sqlbraid/mariadb`, `sqlbraid/node-sqlite`, `sqlbraid/better-sqlite3`, `sqlbraid/libsql`, `sqlbraid/sqlite-wasm`, `sqlbraid/d1`, `sqlbraid/oracledb`, `sqlbraid/tedious`가 있습니다. Bun.SQL에는 여러 방언을 지원하는 `sqlbraid/bun-sql` 어댑터를 쓰세요. 고른 방언의 루트에서 `sql`을 import하고, 그 방언을 명시적으로 넘기세요.

```ts
import { createBunSqlDatabase } from "sqlbraid/bun-sql";
import { sql } from "sqlbraid/postgres";

const client = new Bun.SQL(process.env.DATABASE_URL!);
const db = createBunSqlDatabase(client, { dialect: "postgres" });
```

`node:sqlite` 어댑터는 Node에 들어 있는 모듈을 쓰므로 별도 드라이버 패키지가 필요 없습니다. 애플리케이션이 쓰는 나머지 외부 드라이버는 설치하세요.

루트는 데이터베이스 중립적이며 암묵적인 `sql` 태그를 export하지 않습니다. 방언 전용 하위 경로 `sqlbraid/postgres`, `sqlbraid/mysql`, `sqlbraid/sqlite`, `sqlbraid/oracle`, `sqlbraid/mssql`은 어댑터를 직접 만드는 경우를 위한 것입니다. 세분화된 `@sqlbraid/*` 패키지도 라이브러리 작성자나 의존성을 일부러 좁히려는 경우를 위해 계속 지원합니다.

`sqlbraid/compiled`는 컴파일러가 생성하는 `capture`, `assertDirectiveCondition` 헬퍼를 위한 고급 진입점입니다. 애플리케이션이 쿼리를 작성하는 API가 아니며, 컴파일러를 import하지 않습니다. 컴파일러와 런타임은 같은 버전을 쓰세요.

- `@sqlbraid/bun-sql`은 Bun을 정적으로 import하지 않으며 `dialect`를 반드시 명시해야 합니다. SQL 의미를 자동으로 감지하지 않습니다.
- 런타임 패키지에는 메타데이터, 코드 생성, 컴파일러, 에디터, Vite 의존성이 들어가지 않습니다. 도구 패키지는 개발·빌드 환경에만 설치하세요.
- Oracle, SQL Server, MariaDB, Bun 의존성은 방언 루트에 들어가지 않습니다.
- `@sqlbraid/vite`는 Vite를 피어 의존성으로 두고, 프레임워크를 import하지 않습니다.
- `@sqlbraid/opentelemetry`는 `@opentelemetry/api`를 피어 의존성으로 둡니다. SDK, 익스포터, 로거, 드라이버 계측, 데이터베이스 드라이버를 설치하지 않습니다.

동기 SQLite 어댑터는 물리 SPI의 `Awaitable<T>`를 씁니다. 공개 `Database` 메서드는 계속 비동기입니다.

- `better-sqlite3`는 여전히 이벤트 루프를 막습니다. 정확한 정수는 문장마다 설정을 적용해 읽습니다.
- libSQL은 `{ intMode: "string" }`이 필요하고 대화형 트랜잭션 핸들을 씁니다. `session.pinned`를 지원한다고 주장하지 않습니다. 스트림은 버퍼링하지 않고 `BRAID_STREAM_UNSUPPORTED`를 보고합니다.

이것들은 전송과 기능의 경계이지, 포괄적인 지원 등급이 아닙니다.

- `db.session()`은 프로바이더 리스 하나를 고정하고, `db.tx()`는 그 리스를 다시 씁니다. 세이브포인트와 옵션은 선택한 어댑터가 지원한다고 밝힌 경우에만 쓸 수 있습니다.
- 준비된 쿼리는 물리 플레이스홀더가 아니라 논리적 형태를 고정합니다.
- 활성 취소 여부는 기능 정보에서 정해집니다. 기능이 없으면 `BRAID_CANCEL_UNSUPPORTED`로 실패합니다.
- Bun 1.3.14는 PostgreSQL, MySQL, MariaDB에 `{ bigint: true }`를, SQLite에 `{ safeIntegers: true }`를 씁니다. 열 메타데이터가 없어서, 정수 값의 `Number` 행과 정수 값의 근사 `Number` 행은 모호하다는 이유로 거부합니다.
- PostgreSQL decimal은 텍스트입니다. MySQL·MariaDB DECIMAL과 바이너리 바이트는 SQL에서 텍스트나 16진수로 변환하지 않으면 거부합니다.
- SQLite 네이티브 decimal은 지원하지 않습니다.
- Bun에서 결과가 빈 MySQL·MariaDB `SELECT`와, 0행에 영향을 준 DML·DDL은 guarded 조건 `bun-sql.result-kind-metadata`를 씁니다. 실행 후 `BRAID_RESULT_KIND_AMBIGUOUS`로 실패할 수 있습니다.

Bun.SQL MySQL과 MariaDB는 명시적인 `readOnly: true`와 `readOnly: false`도 I/O 전에 거부합니다(`BRAID_TX_OPTION_UNSUPPORTED`, `transaction.read-only`). 옵션을 생략하면 네이티브 세션 기본값이 유지됩니다. Bun.SQL PostgreSQL의 접근 모드는 바뀌지 않습니다. [트랜잭션 옵션 경계](/SQLBraid/v/1.0.2/runtime/transaction-profiles.md)를 보세요.

의존 방향은 다음과 같습니다.

```text
core / compiler / metadata / codegen
                 ↓
          tooling / vite
             ↙     ↘
           CLI      LSP
                      ↑
                VS Code client
```
