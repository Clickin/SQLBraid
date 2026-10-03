# 5분 SQLite 빠른 시작

> Node 내장 SQLite 드라이버로 첫 SQLBraid 쿼리를 실행합니다.

이 경로는 Node `>=22.18.0`과 `node:sqlite`를 씁니다. 데이터베이스 서버는 필요 없습니다. 첫 번째 쿼리는 평범한 태그 템플릿이라 SQLBraid 컴파일러가 필요 없습니다. 두 번째 쿼리는 동적 `@braid`를 추가하고, SQLBraid에 들어 있는 변환 명령을 씁니다.

## SQLite 어댑터 고르기

모든 SQLite 어댑터는 SQLite 방언을 공유합니다. 하위 경로가 물리 어댑터를 고릅니다.

| 하위 경로                 | 물리 경계                             | 주요 제한                                                                       |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `sqlbraid/node-sqlite`    | Node `DatabaseSync` / `StatementSync` | 동기 물리 호출, 정확한 INTEGER 문자열, 네이티브 `iterate()` 스트림              |
| `sqlbraid/better-sqlite3` | better-sqlite3 문장                   | 동기 호출이며 이벤트 루프를 막음, 문장 단위 `safeIntegers(true)`, 네이티브 반복 |
| `sqlbraid/libsql`         | `@libsql/client`                      | `intMode: "string"` 필수, 대화형 트랜잭션, 세션 고정·스트림 대체 수단 없음      |
| `sqlbraid/sqlite-wasm`    | SQLite WASM OO1                       | OO1 문장 소유, 스트림은 async generator로 감쌈                                  |
| `sqlbraid/d1`             | Cloudflare D1                         | 준비된 문장 바인딩, 스트리밍·콜백 트랜잭션 없음                                 |

Deno 2.9.3에서는 `node:sqlite` 이터레이터가 SQLite step 오류를 정상 EOF로 바꿉니다. 그래서 SQLBraid는 Deno에서 스트리밍을 `BRAID_STREAM_UNSUPPORTED`로 거부합니다. 몰래 잘린 행을 반환하지 않습니다. 메모리로 읽는 쿼리와 트랜잭션은 계속 쓸 수 있습니다. Node의 네이티브 이터레이터는 영향을 받지 않습니다.

공개 `Database` API는 모든 어댑터에서 비동기입니다. `Awaitable<T>`는 물리 `QueryExecutor` SPI의 타입일 뿐입니다. 동기 어댑터가 Promise로 감싸지 않고 결과를 그대로 반환할 수 있게 해 줍니다. better-sqlite3를 논블로킹으로 만들지는 않습니다.

:::note 검증 상태
[런타임·드라이버 지원 매트릭스](/SQLBraid/v/1.0.2/reference/support.md)는 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합마다 등급을 기록하고, 해당 리비전과 워크플로 근거를 함께 남깁니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다. 이 페이지가 npm 배포를 승인하지는 않습니다.
:::

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

Node 22.18.0은 타입만 지우면 되는 이 TypeScript를 바로 실행할 수 있습니다.

```bash
node src/index.ts
```

출력은 `[{ id: "1", name: "Ada" }]` 같은 행 배열입니다. 요청한 ID는 드라이버가 바인딩하는 값이며, SQL 텍스트에 끼워 넣지 않습니다.

node:sqlite 어댑터는 논리 문장을 `?` 플레이스홀더가 있는 텍스트로 렌더링한 뒤, 문서화된 `DatabaseSync.prepare(text)`와 `StatementSync` API를 씁니다. 변환과 힌트 검증은 문장 실행 전에 일어납니다. 재사용을 설정하면 어댑터가 맡습니다. SQLBraid는 문서화되지 않은 호출 경로로 `SQLTagStore`를 부르지 않습니다.

## 3. 동적 @braid를 추가하고 변환하기

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

SQLBraid 컴파일러로 TypeScript 소스를 변환해 빌드한 뒤, 출력된 JavaScript를 실행하세요.

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

컴파일러는 조건부 템플릿을 `build/index.js`로 변환합니다.

- `@braid where`는 하위 항목이 SQL을 출력할 때만 `WHERE`를 붙이고, 맨 앞의 `AND`나 `OR`를 지웁니다.
- 조건이 조건부 값보다 먼저 평가됩니다. 비활성 분기의 식은 평가하지 않습니다.
- 요청한 ID는 일반 SQLite 바인딩으로 남습니다.

## 무슨 일이 일어났나요

1. `DatabaseSync`가 메모리 SQLite 리소스를 가집니다.
2. `createNodeSqliteDatabase(native)`가 그 물리 리소스를 SQLBraid 런타임에 연결합니다.
3. `sql.rows<UserRow>`는 문장이 `UserRow` 형태의 행을 반환한다고 선언합니다.
4. 일반 값은 드라이버 바인딩(SQLite에서는 `?`)이 됩니다. SQL 텍스트가 되지 않습니다.
5. 컴파일러가 동적 템플릿의 조건부 지연 평가를 유지합니다.

쓰기 작업에는 `sql.command`와 `db.execute`를 쓰세요. 정확히 한 행이 필요하면 `db.one`을 쓰세요. 결과가 정확히 한 행이 아니면 행 개수 오류를 던집니다. [SQL 태그와 결과 종류](/SQLBraid/v/1.0.2/concepts/sql-tags.md)를 보세요.

:::caution Node SQLite 지원
`node:sqlite`는 이번 릴리스의 공식 SQLite 어댑터입니다.

- INTEGER 저장 값은 네이티브 int64 전송으로 읽고, 정규 십진 문자열로 노출합니다. 이 내부 전송 방식은 공개 정수 모드가 아닙니다.
- REAL 저장 값은 JavaScript `number`로 남습니다.
- 이 어댑터는 루틴 호출을 지원하지 않습니다. 스트리밍은 `StatementSync.iterate()`를 씁니다.
- SQLite의 스칼라·집계·윈도 함수는 일반 SQL 함수입니다. 가상 테이블과 테이블 값 확장은 일반 SQL 쿼리이며, 저장 프로시저가 아닙니다.
  :::

## SQLite 표현 방식 프로필

`node:sqlite`는 서버 버전이 아니라 Node 런타임 API입니다. 프로필에는 Node 버전과 Node에 포함된 SQLite 라이브러리가 기록됩니다.

| SQLite 항목                  | 프로필 표현               | 상태·주의 사항                                                                |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| INTEGER 저장 값              | string                    | 정확한 정규 십진 텍스트입니다. 네이티브 bigint는 내부 전송에만 쓰입니다.      |
| REAL 저장 값                 | JavaScript `number`       | SQLite binary64 근사 값입니다.                                                |
| `STRICT` 테이블              | SQLite 자체의 친화도 강제 | 스키마 기능이며, SQLBraid 파서가 보장하는 것이 아닙니다.                      |
| STRICT가 아닌 테이블 / `ANY` | SQLite 동적 값            | 반환되는 표현은 저장된 값과 드라이버를 따릅니다.                              |
| JSON1                        | 텍스트                    | JSON 텍스트를 Standard Schema로 파싱·검증하세요.                              |
| BLOB                         | `Buffer`/바이트           | 바이너리를 그대로 유지하거나 명시적으로 인코딩하세요.                         |
| `RETURNING`                  | 메모리로 읽은 행 집합     | 출력은 전달 전에 모두 모읍니다. DML RETURNING의 스트리밍은 주장하지 않습니다. |

- 네이티브 바인딩은 `?` 플레이스홀더와 `StatementSync`를 씁니다. 스트림 기능은 `iterate()`이고, 벌크 방식은 `prepared-loop`입니다.
- SQLite에는 저장 프로시저 전송 방식이 없습니다. 그래서 등록한 함수와 테이블 값 확장은 일반 SQL 행 쿼리로 남습니다.
- 네이티브 SQLite SQL은 문법 재작성 없이 그대로 전달됩니다. SQL을 그대로 전달한다고 해서 문법을 지원한다는 뜻은 아닙니다.
- 정확한 정수 문자열과 검증된 bigint 전송은 바인딩 세부 사항입니다.
- 일반 IN 값이 `undefined`이면 리스를 획득하기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
- 배열 같은 중첩·컨테이너 값은 저장 클래스에 대한 테스트가 증명하기 전까지 분류되지 않은 상태로 남습니다.

### better-sqlite3

```ts
import Database from "better-sqlite3";
import { createBetterSqlite3Database, sql } from "sqlbraid/better-sqlite3";

const native = new Database(":memory:");
const db = createBetterSqlite3Database(native);
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

SQLBraid는 문장마다 `safeIntegers(true)`를 적용해 정확한 INTEGER 값을 십진 문자열로 노출합니다. `iterate()`가 실제 스트림 기능입니다. 벌크는 `prepared-loop`를 씁니다. 네이티브 호출은 이벤트 루프를 막습니다. 문제가 되면 워커를 쓰세요. 루틴과 활성 취소는 지원하지 않습니다.

### libSQL

```ts
import { createClient } from "@libsql/client";
import { createLibsqlDatabase, sql } from "sqlbraid/libsql";

const client = createClient({ url: "file:app.db", intMode: "string" });
const db = createLibsqlDatabase(client, { intMode: "string" });
const rows = await db.all(sql.rows`SELECT 1 AS value`);
```

`intMode: "string"` 옵션을 반드시 명시해야 합니다. SQLBraid는 내부를 알 수 없는 클라이언트의 정수 모드를 추론할 수 없습니다.

- 트랜잭션은 libSQL의 대화형 트랜잭션 핸들을 씁니다. 일반 호출이 세션 하나를 고정한다고 주장하지 않습니다.
- 벌크에는 네이티브 `batch()`를 씁니다.
- `db.stream()`은 `BRAID_STREAM_UNSUPPORTED`로 거부합니다. 전체 결과를 버퍼링하지 않습니다.

로컬 `file:` libSQL 클라이언트와 프로토콜을 알 수 없는 libSQL 클라이언트는 선택 사항인 `command.insertId`를 생략합니다. 네이티브 바인딩이 bigint를 반환하기 전에 ROWID를 Number로 거치면서 반올림하기 때문입니다. 이것은 모든 `intMode`에서 일어납니다. 행 조회, 트랜잭션, 벌크 실행, `affectedRows`는 계속 지원합니다. 정확한 ID가 필요하면 SQL에 `INSERT ... RETURNING id`를 쓰고 `sql.rows`를 쓰세요. SQLBraid는 SQL을 고쳐 쓰거나 보완 쿼리를 보내지 않습니다.

SQLite 인스펙터는 기본으로 `introspectionScope: "main"`을 씁니다. 메타데이터 수집은 연결(attach)된 스키마를 검사하지 않습니다. 필드가 없다고 인덱스나 제약이 없다는 증거가 되지는 않습니다. better-sqlite3와 libSQL 대상은 정확한 런타임·드라이버 근거가 생기기 전까지 Compatible입니다. 비슷하다는 이유로 인증되지 않습니다.

libSQL 트랜잭션 옵션:

- 트랜잭션 옵션을 생략하거나 비워 두면 어댑터는 모드 없이 `client.transaction()`을 호출합니다.
- `readOnly: false`는 `"write"`를 고릅니다.
- 로컬 `@libsql/client@0.18.0` 파일 전송은 `BEGIN TRANSACTION READONLY`를 보내지만 쓰기를 막지 않습니다. 그래서 SQLBraid는 읽기 전용을 guarded로 보고하고, `readOnly: true`는 트랜잭션 시작 전에 거부합니다.
- 전송 프로토콜을 알 수 없는 클라이언트에도 같은 제한이 적용됩니다.
- 문서화된 `"read"` 모드를 노출하고 실제로 강제하는 원격 전송은 이 옵션을 그대로 씁니다.

better-sqlite3는 `Uint8Array` 바인딩 뷰를 받아 네이티브 호출 직전에 `Buffer`로 바꿉니다.
