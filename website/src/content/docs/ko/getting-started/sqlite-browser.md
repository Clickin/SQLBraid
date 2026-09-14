---
title: 브라우저 SQLite와 D1
description: 브라우저 SQLite WASM과 Cloudflare D1 어댑터를 pool이나 cursor를 발명하지 않고 사용합니다.
---

PV16은 SQLite dialect를 하나로 유지하면서 execution driver와 runtime을
분리합니다. 브라우저 코드는 SQLite WASM을 사용하고 Worker binding은
Cloudflare D1을 사용합니다. 두 경로 모두 SQLBraid query contract를
바꾸지 않습니다.

## SQLite WASM

애플리케이션이 소유한 browser/worker resource에 SQLite package와 공식 WASM
runtime을 설치하세요.

```bash
npm install @sqlbraid/sqlite @sqlite.org/sqlite-wasm
```

현재 realm의 OO1-style object에서 직접 database를 만듭니다.

```ts
import { sql } from "@sqlbraid/sqlite";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const db = createSqliteWasmDatabase(wasmDatabase);
const rows = await db.all(sql.rows<{ id: number }>`SELECT id FROM account`);
```

어댑터는 prepare/bind/step/finalize, pull 방식 row streaming, callback
transaction, item마다 prepared statement를 reset하는 command-only bulk를
지원합니다. Pool이 아닌 직접 resource입니다. Transaction 또는 stream이
소유한 동안 충돌하는 root operation은 reject하며 불완전한 async-context
polyfill에 의존하지 않습니다.

## Cloudflare D1

D1은 SQLite로 유지되며 structural binding interface를 사용하므로 package가
runtime에서 Cloudflare type package를 요구하지 않습니다.

```ts
import { createD1Database } from "@sqlbraid/sqlite/d1";

const db = createD1Database(env.DB);
```

D1은 `?1`, `?2`, … ordered bind와 materialized query metadata를 사용합니다.
`db.bulk()`는 하나의 logical shape를 `D1Database.batch()` 1회 호출로 바꾸고
`remote-batch`를 보고합니다. Worker Binding API에 incremental row cursor가
없으므로 `db.stream()`은 `BRAID_STREAM_UNSUPPORTED`이며 streaming을 흉내 내기
위해 pagination하지 않습니다. callback `db.tx()`도 같은 contract에 맞는 D1
primitive가 생기기 전에는 지원하지 않습니다.

Native D1 batch의 transaction 동작이 더 강하더라도 portable SQLBraid contract는
아닙니다. Root bulk는 암묵적 transaction이 아니며 portable auto-chunking 약속이
없습니다.

Browser WASM과 local D1 gate는 정확한 최종 SHA 증거를 기다리고 있습니다.
OPFS persistence, SharedArrayBuffer, remote production support 또는 release
label을 주장하지 않습니다.
