---
title: SQL Server 빠른 시작
description: 결정적인 SQL Server 파라미터 힌트와 함께 SQLBraid를 Tedious에 연결합니다.
---

SQLBraid 런타임 파사드와 Tedious를 함께 설치하세요.

```bash
npm install sqlbraid tedious
```

방언 루트는 SQL Server 방언과 힌트 팩토리를 제공합니다. Node 드라이버 어댑터는 `/tedious`에 있습니다.

```ts
import { Connection } from "tedious";
import { createTediousDatabase, mssqlParameter, sql } from "sqlbraid/tedious";

interface UserRow {
  id: string;
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
  options: {
    database: process.env.SQLSERVER_DATABASE ?? "app",
    encrypt: true,
    trustServerCertificate: process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE === "true",
  },
});
await new Promise<void>((resolve, reject) => {
  connection.once("connect", (error) => (error ? reject(error) : resolve()));
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

TLS 암호화와 인증서 검증은 기본으로 켜져 있습니다. 자체 서명 인증서를 쓰는 격리된 로컬 개발 서버에서만 `SQLSERVER_TRUST_SERVER_CERTIFICATE=true`를 명시적으로 설정하세요. 원격 서버나 운영 서버에는 이 우회 설정을 쓰지 말고, 신뢰할 수 있는 인증서를 구성하세요.

Tedious는 결정적인 파라미터 이름 `@p1`, `@p2`, ...를 받습니다. `sql.bind`는 데이터베이스 타입을 고를 뿐, 값을 SQL 텍스트로 바꾸지 않습니다. 스칼라 OUTPUT·INOUT 루틴 파라미터에는 명시적인 힌트가 필요합니다. T-SQL 정수 RETURN 상태를 받으려면 `sql.call` 선언에 `procedure: { name, parameterNames }` 메타데이터를 명시하세요. SQLBraid는 임의의 `EXEC` 텍스트를 파싱해 프로시저를 추측하지 않습니다.

Tedious 바인딩 어댑터는 논리 문장을 타입이 지정된 요청으로 바꿉니다. 결정적인 `@p1`, `@p2`, … 이름, `TYPES.*` 매핑, 인코딩된 값과 속성이 포함됩니다. 설명, 힌트 검증, 정확도 검사는 리스를 획득하기 전에 일어납니다. 실제 재사용은 Tedious가 맡습니다. 이 단계의 실패는 드라이버 I/O가 없는 `materialize` 오류입니다.

## 기능 경계

- 문서화된 후보 조합은 Node 22.18.0/Linux x64의 Tedious 20.0.0입니다. [런타임·드라이버 지원 매트릭스](/SQLBraid/reference/support/)는 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합마다 등급을 기록하고, 해당 리비전과 워크플로 근거를 함께 남깁니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다.
- 대상 서버는 SQL Server 2022 CU18 Developer, Linux x64입니다. 로컬 ARM 에뮬레이션은 이 가이드의 검증 범위가 아닙니다.
- 힌트가 없는 일반 값은 어댑터의 Tedious 추론을 씁니다. `null`, 직접 만든 객체, 정밀도와 스케일, 길이, SQL Server 전용 타입에는 힌트를 명시하세요.
- 어댑터는 여러 레코드 집합을 그대로 유지합니다. 지어낸 단일 행 결과로 펼치지 않습니다.
- `CURSOR VARYING OUTPUT`은 애플리케이션 커서 채널이 아니므로 `BRAID_CALL_CURSOR_UNSUPPORTED`로 거부합니다. 로컬 커서를 읽고 `SELECT` 행을 출력하는 배치는 그 행을 일반 결과 집합으로 반환합니다.

Tedious는 `decimal`/`numeric`, `money`, `smallmoney`를 JavaScript `number`로 노출합니다. 그래서 SQLBraid는 `BRAID_RESULT_EXACTNESS`로 실패합니다. 손실이 있는 정확한 값을 문자열로 바꾸지 않습니다. Tedious의 `BIGINT` 텍스트는 정규화된 정확한 문자열로 바꿉니다.

- 정확한 소수나 금액 결과가 필요하면 `CONVERT(varchar(100), exact_column)`처럼 길이가 알맞은 텍스트 식을 쓰고, 결과를 문자열로 선언하세요.
- 정확한 입력에는 문자 힌트(`mssqlParameter.nvarchar(...)`)를 쓰고, 변환은 SQL에서 고르세요. 예: `CAST(@nvarchar_parameter AS decimal(38, 18))`. 네이티브 타입 DECIMAL/NUMERIC/MONEY 편의 경로는 범위가 제한된 JavaScript `number` 입력이며, 임의 정밀도를 보장하지 않습니다.
- 네이티브 날짜·시간 값은 `Date`를 씁니다. `Date`는 SQL Server의 100ns 정밀도나 오프셋 의미를 모두 유지하지 못합니다. 정확한 날짜·시간 텍스트가 중요하면 `CONVERT(varchar(...), datetime2_or_datetimeoffset, style)`을 쓰세요.

명시적인 프로시저 메타데이터의 형태와 `sql.call`의 여러 결과 집합 규칙은 [루틴 호출](/SQLBraid/concepts/routines/)을 보세요.

## Tedious 표현 방식 프로필

문서화된 무료 테스트 대상은 Node 22.18.0/Linux x64에서 Tedious 20.0.0을 쓰는 SQL Server 2022 CU18 Developer입니다. 근거 등급은 이 페이지가 아니라 지원 매니페스트가 정합니다. 다른 SQL Server 에디션이나 런타임은 별도의 프로필입니다.

| SQL Server 값                                  | 드라이버 원시 값 / SQLBraid 정규 표현 | 상태·주의 사항                                                                                                    |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tinyint` / `smallint` / `int` / `bigint`      | string                                | 정확한 정수는 정규 텍스트로 전달됩니다. `decodeExactInteger`는 애플리케이션이 선택해서 씁니다.                    |
| `decimal` / `numeric` / `money` / `smallmoney` | number → 정확한 출력은 미지원         | 문자 바인딩과 직접 작성한 텍스트 `CAST`/`CONVERT`를 쓰세요. 손실이 있는 Number를 문자열로 바꾸지 마세요.          |
| `real` / `float`                               | JavaScript `number`                   | 근사 binary32/binary64 값입니다. SQL Server는 NaN/Infinity 지원을 주장하지 않습니다.                              |
| `datetime2` / `datetimeoffset`                 | `Date`                                | 네이티브 편의 프로필입니다. 100ns나 오프셋 정확도가 필요하면 ISO/텍스트 변환을 직접 쓰세요.                       |
| `uniqueidentifier`                             | string                                | 필요하면 애플리케이션 스키마로 검증하세요.                                                                        |
| `varbinary`                                    | `Buffer`                              | 바이트를 그대로 유지하거나 명시적으로 인코딩하세요.                                                               |
| JSON                                           | 텍스트                                | SQL Server JSON은 문자 데이터입니다. SQLBraid가 파싱하지 않으므로 중첩된 숫자 표기를 텍스트로 유지할 수 있습니다. |

- 바인딩 전송 방식은 결정적인 `@p1`, `@p2`, … 이름과 `TYPES.*` 메타데이터를 쓰는 타입 지정 Tedious 요청입니다.
- 네이티브 `OUTPUT` 행은 `sql.rows`로 메모리로 읽습니다. 루틴의 출력·반환 채널은 명시적인 메타데이터를 씁니다.
- 공통 벌크 방식은 prepared-loop입니다.
- `affectedRows`와 프로시저 상태는 안전한 범위를 검사한 작업 값입니다. 데이터베이스가 생성한 ID는 드라이버가 제공하는 경우 정확한 텍스트를 씁니다.
- 일반 IN 값이 `undefined`이면 리스를 획득하기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
- 네이티브 SQL은 바뀌지 않고 그대로 전달됩니다. SQLBraid가 T-SQL 문법 전체를 파싱한다고 주장하지 않습니다.
