---
title: MariaDB 빠른 시작
description: MariaDB Connector/Node.js에서 MariaDB SQL 문법을 명시적으로 유지합니다.
---

별도 MariaDB dialect와 공식 Connector/Node.js 드라이버를 설치하세요.

```bash
npm install sqlbraid mariadb
```

`/mariadb` 어댑터 subpath를 연결된 connection 또는 명시적 pool factory와
함께 사용합니다.

```ts
import mariadb from "mariadb";
import { createMariaDbDatabase, MARIADB_LOSSLESS_TEXT, sql } from "sqlbraid/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
  ...MARIADB_LOSSLESS_TEXT.connectionOptions,
});
const db = createMariaDbDatabase(connection, { profile: MARIADB_LOSSLESS_TEXT });
const users = await db.all(sql.rows<{ id: string; name: string }>`
  SELECT id, name FROM users WHERE id = ${1}
`);
```

Dialect는 `mariadb`입니다. `mysql`이 아닙니다. MariaDB 전용 문법은 SQL에 직접
작성합니다. 현재 capability fixture는 문서화된 `INSERT ... RETURNING`,
`DELETE ... RETURNING`, `REPLACE ... RETURNING`, sequence, CTE, JSON function을
다룹니다.

- `UPDATE ... RETURNING`은 주장하지 않습니다.
- `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING`은 일치하는 서버 증거가
  있을 때만 지원 목록에 올립니다.

어댑터는 Connector/Node.js value-only 실행, native row stream, 그리고
`db.bulk()`를 위한 `connection.batch()` 1회 호출(`native-bulk`)을 사용합니다.
Root bulk는 transaction이 아닙니다. portable 자동 chunking 약속도 없습니다.
callback transaction의 원자성이 필요하면 `db.tx()`를 사용하세요.

`mysql2` connection은 best-effort 호환으로 MariaDB에서 동작할 수 있습니다.
하지만 MariaDB 프로토콜의 증거는 아닙니다. 공식 인증 프로필은 MariaDB 11.8.9 /
Connector 3.5.4 / Node 22.18.0입니다. [런타임/드라이버 지원
매트릭스](/SQLBraid/reference/support/)는 정확한 database, driver, profile,
runtime, capability tuple별 label을 그 revision 및 workflow 증거와 함께
기록합니다. 인접한 버전이나 package 설치는 인증이 아닙니다. 최종 exact-SHA
Runtime, Docs, Release gate와 명시적인 release 승인은 별도 요구사항입니다.

## Connector/Node.js 표현 프로필

첫 번째 파티 MariaDB 프로필은 `mariadb-lossless-text`입니다. 공식
Connector/Node.js adapter와 `representationProfiles` descriptor가 선택한 정확한
option을 사용합니다.

- `@sqlbraid/mariadb`는 `typePolicyForProfile({ json, temporal })`를
  내보냅니다. 따라서 runtime과 codegen이 하나의 immutable TypePolicy를
  사용합니다.
- `mariadb-native`는 별도의 편의 프로필입니다.
- MariaDB에 대한 mysql2 connection은 별도의 best-effort 호환 프로필입니다.

Connector/Node.js는 유효 option을 노출하지 않습니다. descriptor를 생략하거나
일부 option만 선언하면 adapter는 `mariadb-custom-profile`을 보고합니다. 이것은
인증 프로필이 아닙니다. 명시한 descriptor도 guarded 선언입니다. 관측이
아닙니다.

| MariaDB 값                  | Driver raw / SQLBraid canonical 표현 | 주의                                                                                             |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| TINYINT/SMALLINT/INT/BIGINT | driver 의존 → `string`               | 정확한 정수 결과는 canonical text이며 `decodeExactInteger`는 애플리케이션 선택 사항입니다.       |
| DECIMAL/NUMERIC             | text → `string`                      | 정확한 precision과 scale을 text로 유지하며 필요하면 애플리케이션 decimal transform을 사용합니다. |
| FLOAT/DOUBLE                | number → `number`                    | 근사 이진 값은 JavaScript number로 유지합니다.                                                   |
| JSON 별칭                   | `autoJsonMap:false` text → `string`  | `autoJsonMap:true` parsed는 별도 편의 프로필이며 중첩 숫자 정확도를 보장하지 않습니다.           |
| DATE/TIME/DATETIME          | `dateStrings:true` text → `string`   | native `Date`는 별도 편의 프로필이며 fractional/zone 정보를 잃을 수 있습니다.                    |
| BLOB                        | bytes/Buffer                         | byte로 유지하거나 명시적으로 encode합니다.                                                       |

- 어댑터는 value-only 실행, native `queryStream()`, 동종 bulk를 위한
  `connection.batch()` 1회 호출을 사용합니다.
- Native `RETURNING`은 정확한 서버 형태의 증거가 있는 경우에만 materialized row
  선언입니다. `INSERT`, `DELETE`, `REPLACE`는 별도 capability입니다. `UPDATE`는
  주장하지 않습니다.
- SQL은 변경 없이 전달됩니다. MariaDB grammar 지원이 아닙니다.
- `db.call()`은 prepared `CALL`이 내보내는 이종 결과 집합을 materialize합니다.
  OUT, INOUT, cursor descriptor는 지원하지 않습니다.
- `db.prepare()`는 query-bound Standard Schema 매핑을 유지합니다.
- 선택적 `/inspector` subpath는 오프라인 `generateModels()`를 위해 identity,
  generated/write 플래그, 숫자 precision/scale을 기록합니다. 루틴 signature는
  불완전한 positive evidence로 남습니다.

`db.call()`은 prepared `CALL`이 내보내는 이종 결과 집합을 materialize합니다.
OUT, INOUT, cursor descriptor는 지원하지 않습니다. `db.prepare()`는 query-bound
Standard Schema 매핑을 보존합니다. 선택적 `/inspector` subpath는 오프라인
`generateModels()`를 위한 identity, generated/write 플래그, 숫자 precision/scale을
기록하며 루틴 signature는 불완전한 positive evidence로 유지합니다.

`mariadb-lossless-text` descriptor는 `bigintAsNumber: false`,
`decimalAsNumber: false`, `insertIdAsNumber: false`, `autoJsonMap: false`,
`dateStrings: true`, `timezone: "Z"`를 사용합니다.

- 정확한 정수/10진수 string은 execute, prepared, 증명된 bulk 전략에서 왕복
  정확도를 위한 bind 경로입니다.
- `affectedRows`는 safe-range 검사를 하는 운영 count입니다.
- 일반 IN 값의 `undefined`는 acquisition 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로
  실패합니다. `null`은 SQL `NULL`입니다.
- Connector 3.5.4의 public typings에는 `jsonStrings` 옵션이 없습니다. 따라서
  text에는 `autoJsonMap: false`를 사용하세요. mysql2 프로필이라고 설명하지
  마세요.
