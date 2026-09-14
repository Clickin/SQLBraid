---
title: MariaDB 빠른 시작
description: MariaDB Connector/Node.js에서 MariaDB SQL 문법을 명시적으로 유지합니다.
---

별도 MariaDB dialect와 공식 Connector/Node.js 드라이버를 설치하세요.

```bash
npm install @sqlbraid/mariadb mariadb
```

`/mariadb` 어댑터 subpath를 연결된 connection 또는 명시적 pool factory와
함께 사용합니다.

```ts
import mariadb from "mariadb";
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
});
const db = createMariaDbDatabase(connection);
const users = await db.all(sql.rows<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE id = ${1}
`);
```

Dialect는 `mysql`이 아닌 `mariadb`입니다. MariaDB 전용 문법은 SQL로
그대로 작성합니다. 현재 capability fixture는 문서화된
`INSERT ... RETURNING`, `DELETE ... RETURNING`, `REPLACE ... RETURNING`,
sequence, CTE, JSON function을 다룹니다. `UPDATE ... RETURNING`은 주장하지
않으며, `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING`은 실제 서버 증거가
있을 때만 지원 목록에 올립니다.

어댑터는 Connector/Node.js value-only 실행, native row stream, 그리고
`db.bulk()`의 `connection.batch()` 1회를 사용합니다. Root bulk는 암묵적으로
transaction이 되지 않고 portable auto-chunking 약속이 없습니다. 원자성이
필요하면 `db.tx()`를 사용하세요.

MariaDB에서 `mysql2` connection이 동작할 수 있지만 best-effort 호환일 뿐
Official MariaDB 문법/protocol 증거가 아닙니다. 인증한 프로필은 MariaDB
11.8.9 / Connector 3.5.4 / Node 22.18.0입니다. revision별 릴리스 증거는
support manifest에 기록하며 패키지 설치 여부에서 추론하지 않습니다.

## Connector/Node.js 표현 프로필

첫 번째 MariaDB 프로필은 support manifest가 지정한 정확한 Node/server
조합에서 공식 Connector/Node.js adapter를 사용하는 것입니다. MariaDB에
대한 mysql2 connection은 별도의 best-effort 호환 프로필입니다.

| MariaDB 값 | Connector 표현 | 주의 |
| --- | --- | --- |
| BIGINT | `bigint` | 정확한 정수를 유지하며 JSON 직렬화 전에 인코딩을 명시적으로 선택합니다. |
| DECIMAL | `string` | precision과 scale을 유지하며 애플리케이션 10진 라이브러리는 선택 사항입니다. |
| JSON 별칭 | 기본 `autoJsonMap: true`에서는 객체, 명시적 SQL `CAST(... AS CHAR)`에서는 텍스트 | parser 옵션을 기록하고 Standard Schema로 검증합니다. |
| DATE/TIMESTAMP | driver temporal 값 | `Date`는 원본 offset/precision 세부 정보를 잃을 수 있습니다. |
| BLOB | bytes/Buffer | byte로 유지하거나 명시적으로 encode합니다. |

어댑터는 value-only 실행, native `queryStream()`, 동종 bulk를 위한
`connection.batch()` 1회를 사용합니다. Native `RETURNING`은 정확한 서버
형태의 증거가 있는 경우에만 materialized row 계약입니다. `INSERT`,
`DELETE`, `REPLACE`는 별도 capability이며 `UPDATE`는 주장하지 않습니다.
SQL은 투명하게 전달되지만 MariaDB grammar 지원을 의미하지 않습니다.

`db.call()`은 prepared `CALL`이 내보내는 이종 결과 집합을 materialize합니다.
OUT, INOUT, cursor descriptor는 지원하지 않습니다. `db.prepare()`는 query-bound
Standard Schema 매핑을 보존합니다. 선택적 `/inspector` subpath는 오프라인
`generateModels()`를 위한 identity, generated/write 플래그, 숫자 precision/scale을
기록하며 루틴 signature는 불완전한 positive evidence로 유지합니다.
