---
title: 브라우저 SQLite와 D1
description: 브라우저 SQLite WASM과 Cloudflare D1 어댑터를 pool이나 cursor를 발명하지 않고 사용합니다.
---

PV18은 SQLite dialect를 하나로 유지하면서 execution driver와 runtime을
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

const db = createSqliteWasmDatabase(wasmDatabase, { sqlite3 });
const rows = await db.all(sql.rows<{ id: string }>`SELECT id FROM account`);
```

INTEGER storage는 canonical decimal string으로 노출됩니다. WASM adapter는
숫자 모양을 추측하지 않고 native column type과 `sqlite3_column_int64`를
사용하므로 정수 모양 REAL은 `number`로 유지됩니다. Native bigint는 내부
전송 세부사항이며 public integer mode가 아닙니다. D1은 별도의 guarded
프로필입니다. safe range의 정수형 JavaScript Number는 string이 되며 범위를
벗어난 값은 반올림하지 않고 unsupported입니다.

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

D1은 DB type 정보 없이 JavaScript number를 반환합니다. Guarded profile은
safe range 밖의 정수 모양 number를 거부합니다. 공개 result API로 반올림된
INTEGER와 구분할 수 없어 같은 범위의 정수 모양 REAL도 제외됩니다.
전체 int64 또는 정확한 decimal 출력을 보장하지 않습니다.
API가 `sqlite_version()`을 거부하므로 `db.environment()`는 server version을
알 수 없는 상태로 둡니다. Worker compatibility date는 database version이 아닙니다.

D1은 `?1`, `?2`, … ordered bind와 materialized query metadata를 사용합니다.
`db.bulk()`는 하나의 logical shape를 `D1Database.batch()` 1회 호출로 바꾸고
`remote-batch`를 보고합니다. Worker Binding API에 incremental row cursor가
없으므로 `db.stream()`은 `BRAID_STREAM_UNSUPPORTED`이며 streaming을 흉내 내기
위해 pagination하지 않습니다. callback `db.tx()`도 같은 contract에 맞는 D1
primitive가 생기기 전에는 지원하지 않습니다.

Native D1 batch의 transaction 동작이 더 강하더라도 portable SQLBraid contract는
아닙니다. Root bulk는 암묵적 transaction이 아니며 portable auto-chunking 약속이
없습니다.

지원 label과 증거는 [런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)가
기록한 정확한 database, driver, profile, runtime, capability tuple과 revision별
실행 workflow에만 적용됩니다. 로컬 D1은 managed SQLite 버전이 공개되지 않아
Compatible입니다. 인접한 버전·runtime·profile 또는 package 설치로 이 상태를
인증하지 마세요. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인 release
승인은 별도 요구사항이며, 어떤 browser gate도 OPFS persistence,
SharedArrayBuffer, remote production support 또는 npm 발행을 주장하지 않습니다.

## Browser와 Worker 표현 프로필

SQLite는 같은 dialect이지만 WASM과 D1은 서로 다른 driver이므로 하나의
증거 label을 공유하면 안 됩니다.

| Driver | Driver raw / SQLBraid canonical 경계 | Stream/bulk/transaction |
| --- | --- | --- |
| SQLite WASM OO1 | SQLite dynamic value이며 INTEGER storage는 canonical string | pull iteration, prepared-loop bulk, callback transaction |
| Cloudflare D1 binding | materialized 행과 순서가 있는 `?1`, `?2`, … bind | native `batch()` bulk; streaming과 callback transaction은 지원하지 않음 |

선택한 WASM build/parser가 다른 표현을 증명하지 않는 한 JSON1은 text입니다.
BLOB는 byte로 유지합니다. Native `RETURNING`은 전달 전에 materialize됩니다.
Browser SQL은 투명하게 전달되지만 browser runtime이 SQL grammar 구현이 되는
것도, Node 전용 adapter가 browser 호환이 되는 것도 아닙니다.
