---
title: Oracle 빠른 시작
description: 명시적인 Oracle 파라미터 힌트와 Thin 모드 node-oracledb로 SQLBraid에 연결합니다.
---

SQLBraid Oracle 패키지와 드라이버를 함께 설치합니다.

```bash
npm install @sqlbraid/oracle oracledb
```

이식 가능한 루트 패키지는 `oracledb`를 가져오지 않습니다. Node 어댑터는 드라이버 서브패스가 소유합니다.

```ts
import oracledb from "oracledb";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";

interface UserRow {
  id: string;
  name: string;
}

const connection = await oracledb.getConnection({
  user: process.env.ORACLE_USER ?? "app",
  password: process.env.ORACLE_PASSWORD ?? "password",
  connectString: process.env.ORACLE_CONNECT_STRING ?? "localhost/FREEPDB1",
});
const db = createOracledbDatabase(connection);

try {
  const accountNumber = 1001;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id AS "id", name AS "name"
    FROM users
    WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
  `);
  console.log(users);
} finally {
  await connection.close();
}
```

`sql.bind`는 값을 SQL 텍스트와 분리한 채 Oracle 데이터베이스 파라미터 타입을 지정합니다. 힌트가 없으면 어댑터는 문서화된 드라이버 추론을 사용합니다. SQLBraid는 TypeScript의 `number`, `string`, `Date`를 Oracle 타입의 보편적인 근거로 취급하지 않습니다.

## 기능 경계

- 첫 번째 지원 대상은 `node-oracledb` Thin 모드입니다. Thick 모드는 Official 주장이 아닙니다.
- OUT/IN OUT 디스크립터가 아직 바인드 API에 없으므로 이 RC에서 `call()`은 Unsupported입니다.
- 스트리밍은 드라이버의 ResultSet 프로토콜을 사용하며 완료, 중단, 조기 종료 시 ResultSet을 닫습니다.
- 로컬 Node 22.18.0 테스트는 Oracle 23.9.0.25.07을 사용합니다. portable root와 Thin 어댑터는 같은 revision의 CI가 Official 범위를 증명하기 전까지 보수적으로 Compatible입니다. [런타임 및 드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.

드라이버가 안전한 Oracle 타입을 추론할 수 없는 `null`에는 명시적인 힌트를 사용하세요. 타입이 지정되지 않은 null을 조용히 `VARCHAR2`로 바꾸지 않습니다.

기본 정책은 정밀도를 보존하기 위해 `NUMBER` 결과를 문자열로 가져옵니다. 명시적인 `NUMBER` 입력은 `number` 또는 `bigint`를 받으며, 소수 문자열은 손실 변환하지 않고 거부합니다. SQL에서 소수 문자열 입력이 필요하면 일반 문자열 바인드와 명시적인 SQL 변환을 사용하세요.

Thin 어댑터는 기본 타입 힌트를 적용하지만 길이·precision·scale 속성은 거부합니다. node-oracledb가 IN 파라미터에서 이 제약을 표현할 수 없기 때문입니다. 제약은 SQL이나 스키마에 선언하세요. 사용자 정의 executor에서는 해당 디스크립터를 사용할 수 있습니다. 구체화된 CLOB/NCLOB는 문자열, BLOB/RAW는 버퍼이며 lease 반환 후 살아 있는 LOB를 보유하지 않습니다. 시간 값은 `Date`를 사용하므로 원래 시간대 이름이나 밀리초 미만 정밀도를 보존하지 않습니다.
