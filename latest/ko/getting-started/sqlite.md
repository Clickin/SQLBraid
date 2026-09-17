# 5분 SQLite 빠른 시작

> Node에 내장된 SQLite 드라이버로 첫 SQLBraid 쿼리를 실행합니다.

이 경로는 Node `>=22.18.0` 및 `node:sqlite`를 사용하며 데이터베이스 서버가 필요하지 않습니다. 첫 번째 쿼리는 단순한 태그 템플릿이므로 SQLBraid 컴파일러가 필요하지 않습니다. 두 번째 쿼리는 동적 `@braid`를 추가하고 함께 제공되는 lowering 명령을 사용합니다.

## SQLite adapter 선택

SQLite dialect는 공유하지만 물리적 adapter는 subpath로 선택합니다.

| Subpath                   | 물리적 경계                           | 중요한 제한                                                                                |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sqlbraid/node-sqlite`    | Node `DatabaseSync` / `StatementSync` | 물리 호출은 동기식이며 INTEGER는 exact string; stream은 native `iterate()`                 |
| `sqlbraid/better-sqlite3` | better-sqlite3 statement              | 동기식이고 event loop를 block함; statement-local `safeIntegers(true)`와 native iteration   |
| `sqlbraid/libsql`         | `@libsql/client`                      | `intMode: "string"` 필요; interactive transaction; pinned session이나 stream fallback 없음 |
| `sqlbraid/sqlite-wasm`    | SQLite WASM OO1                       | OO1 statement ownership; stream은 async generator로 변환                                   |
| `sqlbraid/d1`             | Cloudflare D1                         | prepared bind; streaming과 callback transaction 없음                                       |

Deno 2.9.3의 `node:sqlite` iterator는 SQLite 실행 오류를 정상 EOF로
처리합니다. SQLBraid는 일부 행만 반환하고 성공한 것처럼 보이는 대신 Deno의
streaming을 `BRAID_STREAM_UNSUPPORTED`로 거부합니다. Materialized query와
transaction은 계속 사용할 수 있으며 Node의 native iterator에는 영향이 없습니다.

모든 adapter의 public `Database` API는 async로 유지됩니다. `Awaitable<T>`는
동기식 adapter가 Promise wrapper 없이 plain result를 반환하도록 하는
물리 `QueryExecutor` SPI 타입일 뿐이며, better-sqlite3를 non-blocking으로
만들지는 않습니다.

:::note 검증 상태
지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)가
기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별
실행 workflow에만 적용됩니다. package 설치나 인접한 버전·runtime은 이
checkout을 인증하지 않습니다. 최종 exact-SHA Runtime, Docs, Release gate와
명시적인 release 승인은 별도 요구사항입니다. 이 문서는 npm 발행을 승인하지
않습니다.
:::

## SQLite 표현 프로필

`node:sqlite`는 server version이 아니라 Node runtime API입니다. 프로필에는
Node와 Node에 번들된 SQLite library를 기록합니다. INTEGER는 public 결과에서
canonical `string`이며 native `bigint`는 어댑터 내부 표현일 뿐입니다.

| SQLite 표면              | 프로필 표현                        | 상태/주의                                                                 |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| INTEGER                  | JavaScript `string`                | int64를 lossless하게 보존합니다. native `bigint`는 public API가 아닙니다. |
| REAL                     | JavaScript `number`                | IEEE binary 부동소수점이며 decimal exactness를 주장하지 않습니다.         |
| `STRICT` table           | SQLite native affinity enforcement | schema 기능이며 SQLBraid parser 보장이 아닙니다.                          |
| non-STRICT table / `ANY` | SQLite dynamic value               | 저장된 값과 driver에 따라 반환 표현이 달라집니다.                         |
| JSON1                    | text                               | Standard Schema로 JSON text를 파싱/검증합니다.                            |
| BLOB                     | `Buffer`/bytes                     | binary로 유지하거나 명시적으로 encode합니다.                              |
| `RETURNING`              | materialized rowset                | 전달 전에 output을 축적하며 DML-returning stream은 주장하지 않습니다.     |

Native binding은 `?` placeholder와 `StatementSync`를 사용하고, `iterate()`가
stream primitive이며 prepared loop가 bulk 전략입니다. SQLite에는
stored-procedure transport가 없으므로 등록 function과 table-valued extension은
일반 SQL row query입니다. Native SQLite SQL은 grammar rewrite 없이 전달되며,
투명성은 grammar 지원을 뜻하지 않습니다.

### better-sqlite3

```ts
import Database from "better-sqlite3";
import { createBetterSqlite3Database, sql } from "sqlbraid/better-sqlite3";

const native = new Database(":memory:");
const db = createBetterSqlite3Database(native);
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

SQLBraid는 statement마다 `safeIntegers(true)`를 적용하며 exact INTEGER를
decimal string으로 노출합니다. `iterate()`가 실제 stream primitive이고
bulk는 prepared loop를 사용합니다. Native 호출은 event loop를 block하므로
필요하면 worker를 사용하세요. Routine과 active cancellation은 지원하지
않습니다.

### libSQL

```ts
import { createClient } from "@libsql/client";
import { createLibsqlDatabase, sql } from "sqlbraid/libsql";

const client = createClient({ url: "file:app.db", intMode: "string" });
const db = createLibsqlDatabase(client, { intMode: "string" });
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

opaque client의 integer mode를 SQLBraid가 추론할 수 없으므로 명시적인
`intMode: "string"` option이 필요합니다. Transaction은 libSQL interactive
transaction handle을 사용하며 일반 호출은 하나의 pinned session을
주장하지 않습니다. Native `batch()`를 bulk에 사용하고, 완전한 result를
buffering하는 대신 `db.stream()`은 `BRAID_STREAM_UNSUPPORTED`로 거부합니다.
옵션을 생략하거나 빈 객체를 사용하면 mode 없이 `client.transaction()`을
호출하고 `readOnly: false`는 `"write"`를 선택합니다. 로컬
`@libsql/client@0.18.0` file transport는 `BEGIN TRANSACTION READONLY`를
생성하지만 write를 거부하지 않으므로 SQLBraid는 read-only를 guarded로
보고하고 `readOnly: true`를 begin 전에 거부합니다. 문서화된 `"read"` mode를
노출하고 enforce하는 remote transport에서는 해당 option을 유지하며 transport
protocol이 없는 opaque client는 같은 guard를 적용합니다. better-sqlite3는
`Uint8Array` bind view를 받아 native 호출 직전에 `Buffer`로 변환합니다.

SQLite inspector의 기본 `introspectionScope: "main"`은 main schema만
검사합니다. attached schema는 검사되지 않으며, 누락된 index나 constraint를
존재하지 않는다는 증거로 해석하면 안 됩니다. better-sqlite3와 libSQL target은
정확한 runtime/driver evidence가 추가되기 전까지 compatible이며 certified가
아닙니다.

## 1. 프로젝트 만들기

```bash
mkdir braid-sqlite && cd braid-sqlite
npm init -y
npm pkg set type=module
npm install sqlbraid
npm install --save-dev typescript @types/node@22
mkdir src
```

## 2. 간단한 쿼리 하나 실행하기

`src/index.ts`를 만드세요.

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

  const db = createNodeSqliteDatabase(native);
  const requestedId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${requestedId}
  `);
  console.log(users);
} finally {
  native.close();
}
```

Node 22.18.0은 이 삭제 가능한 TypeScript를 직접 실행할 수 있습니다.

```bash
node src/index.ts
```

출력은 `[{ id: "1", name: "Ada" }]`와 같은 행 배열입니다. 요청한 ID는 드라이버에 바인드되는 값이며 SQL 텍스트에 삽입되지 않습니다.

node:sqlite 어댑터는 논리 문장을 `?` placeholder가 있는 텍스트로 만든 뒤
문서화된 `DatabaseSync.prepare(text)`와 `StatementSync` API를 사용합니다.
구체화와 힌트 검증은 statement 실행 전에 끝납니다. reuse가 필요하면
어댑터가 소유하며, SQLBraid는 문서화되지 않은 `SQLTagStore` 호출 경로를
사용하지 않습니다.

## 3. 동적 @braid 추가 및 lowering

`src/index.ts`에서 `requestedId` 선언과 쿼리 블록을 다음 코드로 바꾸세요.

```ts
const requestedId: number | undefined = 1;
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${requestedId !== undefined}*/
      AND id = ${requestedId}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
```

SQLBraid 컴파일러의 lowering으로 TypeScript 소스를 빌드한 다음 생성된 JavaScript를 실행하세요.

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

컴파일러는 보호된 템플릿을 `build/index.js`로 lowering합니다. `@braid where`는 자식이 SQL을 생성할 때만 `WHERE`를 내보내고 선행 `AND`/`OR`를 제거합니다. 조건은 보호된 값보다 먼저 평가되며, 비활성 분기의 표현식은 평가되지 않습니다. 요청한 ID는 일반적인 SQLite 바인드로 남습니다.

## 무슨 일이 일어났나요?

1. `DatabaseSync`가 메모리 SQLite 리소스를 소유합니다.
2. `createNodeSqliteDatabase(native)`가 해당 물리적 리소스를 SQLBraid 런타임에 맞춥니다.
3. `sql.rows<UserRow>`가 이 문장이 `UserRow` 형태의 행을 반환한다고 선언합니다.
4. 일반 값은 SQL 텍스트가 아닌 드라이버 바인드(SQLite에서는 `?`)가 됩니다.
5. 컴파일러는 동적 템플릿의 지연된 보호 평가를 보존합니다.

쓰기에는 `sql.command`와 `db.execute`를 사용하세요. 정확히 한 행에는 `db.one`을 사용합니다. 결과에 한 행이 없으면 카디널리티 오류가 발생합니다. [SQL 태그와 결과 종류](/SQLBraid/latest/concepts/sql-tags.md)를 참고하세요.

:::caution Node SQLite 지원
`node:sqlite`는 이 릴리스에서 사용하는 첫 번째 파티 SQLite 어댑터입니다.
SQLite 어댑터는 루틴 호출을 지원하지 않으며 스트리밍에는
`StatementSync.iterate()`를 사용합니다. INTEGER 결과는 public API에서
canonical string으로 반환되며, 정밀도가 필요한 REAL/JSON/temporal 값은
`CAST(... AS TEXT)` 또는 lossless text profile을 명시하세요. `undefined` 일반
IN 값은 acquire 전에 거부되고 `null`은 SQL `NULL`입니다. SQLite
scalar/aggregate/window function은 일반 SQL 함수이며 virtual-table/table-valued
extension도 stored procedure가 아닌 일반 행 쿼리입니다.
:::
