---
title: SQL Server 빠른 시작
description: 결정적인 SQL Server 파라미터 힌트와 Tedious로 SQLBraid에 연결합니다.
---

SQLBraid SQL Server 패키지와 Tedious를 함께 설치합니다.

```bash
npm install @sqlbraid/mssql tedious
```

이식 가능한 루트는 SQL Server dialect와 힌트 팩토리를 내보냅니다. Node 드라이버 어댑터는 `/tedious` 아래에 있습니다.

```ts
import { Connection } from "tedious";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";

interface UserRow {
  id: number;
  name: string;
}

const connection = new Connection({
  server: process.env.SQLSERVER_HOST ?? "localhost",
  authentication: {
    type: "default",
    options: {
      userName: process.env.SQLSERVER_USER ?? "sa",
      password: process.env.SQLSERVER_PASSWORD ?? "Password!123",
    },
  },
  options: { database: process.env.SQLSERVER_DATABASE ?? "app", trustServerCertificate: true },
});
await new Promise<void>((resolve, reject) => {
  connection.once("connect", (error) => error ? reject(error) : resolve());
  connection.connect();
});
const db = createTediousDatabase(connection);

try {
  const name = "Ada";
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name
    FROM users
    WHERE name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
  `);
  console.log(users);
} finally {
  connection.close();
}
```

Tedious는 `@p1`, `@p2` 같은 결정적인 파라미터 이름을 받습니다. `sql.bind`는 데이터베이스 타입을 선택할 뿐 값을 SQL 텍스트로 바꾸지 않습니다. OUT/return-value 루틴 바인딩은 이 RC에서 Unsupported입니다.

## 기능 경계

- CI는 Node 22.18.0/Linux x64에서 Tedious 어댑터를 검증하고, 고정 Node/Bun/Deno 버전에서 portable root를 별도로 검사합니다.
- SQL Server 게이트는 2022 CU18(16.0.4185.3), Linux x64를 사용합니다. 로컬 ARM 에뮬레이션은 Official ARM 지원 주장이 아닙니다.
- 힌트가 없는 일반 값은 어댑터 로컬 Tedious 추론을 사용합니다. `null`, 사용자 정의 객체, 정밀도/스케일, 길이 또는 SQL Server 전용 타입에는 명시적인 힌트를 사용하세요.
- 여러 recordset을 하나의 가짜 단일 행 결과로 평탄화하지 않고 보존합니다.

Tedious는 `decimal`/`numeric` 결과를 JavaScript 숫자로 반환하므로 기본 정책은 임의 정밀도 소수 결과를 보장하지 않습니다. 유효숫자 15자리를 초과하는 명시적인 소수 문자열 입력은 `BRAID_BIND_DECIMAL_EXACTNESS`로 거부합니다. 정확한 소수 텍스트가 필요하면 SELECT에서 명시적으로 문자열로 변환하고 결과 계약을 문자열로 선언하세요. `bigint` 결과는 문자열입니다. 날짜와 시간은 `Date`를 사용하므로 원래 offset이나 밀리초 미만 정밀도를 보존하지 않습니다.

증거 라벨과 현재 매트릭스는 [런타임 및 드라이버 지원](/SQLBraid/reference/support/)을 참고하세요.
