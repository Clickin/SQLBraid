---
title: 브라우저 SQLite와 D1
description: 브라우저용 풀이나 커서를 지어내지 않고 SQLite WASM과 Cloudflare D1 어댑터를 씁니다.
---

SQLBraid에서 SQLite는 하나의 방언입니다. 실행 드라이버와 런타임은 따로 구분합니다. 브라우저 코드는 SQLite WASM을, Worker 바인딩은 Cloudflare D1을 씁니다. 어느 경로를 써도 SQLBraid의 쿼리 규칙은 같습니다.

## SQLite WASM

이 예제에는 Node `>=22.18.0`이 필요하며 Node에서 실행합니다. 브라우저 애플리케이션은 같은 `sqlite3`와 `oo1.DB` 객체를 만듭니다.

브라우저나 워커 리소스를 가진 애플리케이션에 SQLBraid 런타임 파사드, SQLite 패키지, 공식 WASM 런타임을 함께 설치하세요.

```bash
mkdir braid-wasm-app && cd braid-wasm-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite @sqlite.org/sqlite-wasm
mkdir src
```

현재 realm의 OO1 스타일 객체로 직접 연결 데이터베이스를 하나 만드세요. 이 코드를 `src/index.ts`로 저장하고 `node src/index.ts`로 실행하세요.

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import { sql } from "@sqlbraid/sqlite";

const sqlite3 = await sqlite3InitModule();
const wasmDatabase = new sqlite3.oo1.DB(":memory:");
wasmDatabase.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL)");
wasmDatabase.exec("INSERT INTO account (email) VALUES ('ada@example.com')");

const db = createSqliteWasmDatabase(wasmDatabase, { sqlite3 });
const rows = await db.all(sql.rows<{ id: string; email: string }>`SELECT id, email FROM account`);
console.log(rows);
wasmDatabase.close();
```

출력은 `[{ id: '1', email: 'ada@example.com' }]`입니다.

INTEGER 저장 값은 정규 십진 문자열로 노출됩니다. WASM 어댑터는 숫자 값으로 추측하지 않고, 네이티브 열 타입과 `sqlite3_column_int64`를 씁니다. 정수 값을 가진 REAL은 `number`로 남습니다. 네이티브 bigint는 내부 전송 세부 사항이며, 공개 정수 모드가 아닙니다. D1은 별도의 guarded 프로필입니다. 안전한 범위의 정수 JavaScript Number는 문자열이 되고, 범위를 벗어난 값은 반올림하지 않고 미지원으로 처리합니다.

어댑터는 다음 작업을 지원합니다.

- prepare, bind, step, finalize
- 풀(pull) 방식의 행 스트리밍
- 콜백 트랜잭션
- 명령 전용 벌크 (준비된 문장 하나를 항목마다 reset)

이것은 풀이 아니라 직접 연결 리소스입니다. 트랜잭션이나 스트림이 리소스를 쓰는 동안 충돌하는 루트 작업은 거부됩니다. SQLBraid는 불완전한 async-context 폴리필에 기대지 않습니다.

## Cloudflare D1

이 예제에는 Node `>=22.18.0`이 필요하며, 로컬 D1 데이터베이스로 Worker를 실행합니다.

파사드와 SQLite 패키지를 설치하세요. D1에는 WASM 런타임이 필요 없습니다. Wrangler가 Worker를 로컬에서 실행합니다.

```bash
mkdir braid-d1-app && cd braid-d1-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite
pnpm add --save-dev wrangler
mkdir src
```

이 설정을 `wrangler.jsonc`로 저장하세요.

```jsonc
{
  "name": "braid-d1-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "d1_databases": [{ "binding": "DB", "database_name": "braid", "database_id": "local" }],
}
```

D1도 SQLite입니다. 구조적 바인딩 인터페이스를 쓰므로 런타임에 Cloudflare 타입 패키지가 필요 없습니다. 이 Worker를 `src/index.ts`로 저장하세요.

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";
import { sql } from "@sqlbraid/sqlite";

interface Env {
  DB: Parameters<typeof createD1Database>[0];
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const db = createD1Database(env.DB);
    const rows = await db.all(sql.rows<{ id: string; email: string }>`SELECT id, email FROM account`);
    return Response.json(rows);
  },
};
```

로컬 테이블을 만들고 Worker를 시작한 다음, 다른 터미널에서 요청하세요.

```bash
pnpm exec wrangler d1 execute braid --local --command "CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL); INSERT INTO account (email) VALUES ('ada@example.com');"
pnpm exec wrangler dev
```

```bash
curl http://localhost:8787
```

응답은 `[{"id":"1","email":"ada@example.com"}]`입니다.

D1은 타입 정보가 없는 JavaScript 숫자를 노출합니다. guarded 프로필은 안전한 범위를 벗어난 정수 숫자를 거부합니다. 범위를 벗어난 정수 값의 REAL도 거부합니다. 공개 결과 API로는 반올림된 INTEGER 값과 구별할 수 없기 때문입니다. 완전한 int64나 정확한 소수 출력을 약속하지 않습니다. API가 `sqlite_version()`을 막기 때문에 `db.environment()`의 서버 버전은 알 수 없음으로 남습니다. Worker 호환성 날짜는 데이터베이스 버전이 아닙니다.

- D1은 순서가 있는 `?1`, `?2`, … 바인딩과, 메모리로 읽는 쿼리를 위한 공개 결과 메타데이터를 씁니다.
- `db.bulk()`는 논리적 형태 하나를 `D1Database.batch()` 호출 한 번으로 바꾸고 `remote-batch`를 보고합니다.
- D1의 Worker Binding API에는 점진적 행 커서가 없습니다. `db.stream()`은 `BRAID_STREAM_UNSUPPORTED`입니다. SQLBraid는 스트리밍을 흉내 내려고 페이지 단위로 나눠 읽지 않습니다.
- 앞으로 D1에 SQLBraid의 콜백 트랜잭션 규칙에 맞는 기능이 생기기 전까지 콜백 `db.tx()`는 지원하지 않습니다.

네이티브 D1 배치는 루트 벌크보다 강한 트랜잭션 동작을 가질 수 있습니다. 하지만 SQLBraid의 공통 규칙은 아닙니다. 루트 벌크는 트랜잭션이 아니며, 자동 분할에 대한 공통 보장도 없습니다.

SQLite WASM과 Cloudflare D1의 세부 기능 지원 여부는 [런타임·드라이버 지원 매트릭스](/SQLBraid/reference/support/)에서 확인할 수 있습니다. Cloudflare D1은 Worker 바인딩이 내부 SQLite 버전을 노출하지 않으므로 Compatible 등급으로 분류됩니다.

## 브라우저와 Worker의 표현 방식 프로필

방언은 똑같이 SQLite입니다. 하지만 WASM과 D1은 서로 다른 드라이버이므로 근거 등급을 공유하면 안 됩니다.

| 드라이버             | 드라이버 원시 값 / SQLBraid 정규 경계               | 스트림·벌크·트랜잭션                                       |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| SQLite WASM OO1      | SQLite 동적 값, INTEGER 저장 값은 정규 문자열       | 풀 방식 반복, prepared-loop 벌크, 콜백 트랜잭션            |
| Cloudflare D1 바인딩 | 메모리로 읽은 행과 순서가 있는 `?1`, `?2`, … 바인딩 | 네이티브 `batch()` 벌크, 스트리밍과 콜백 트랜잭션은 미지원 |

- 선택한 WASM 빌드나 파서가 다른 표현을 증명하지 않는 한, JSON1은 텍스트입니다.
- BLOB 값은 바이트로 남습니다.
- 네이티브 `RETURNING`은 전달 전에 메모리로 모두 읽습니다.
- 브라우저 SQL은 바뀌지 않고 그대로 전달됩니다. 그렇다고 브라우저 런타임이 SQL 문법 구현이 되는 것은 아니며, Node 전용 어댑터가 브라우저와 호환되는 것도 아닙니다.
