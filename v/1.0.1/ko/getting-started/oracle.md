# Oracle 빠른 시작

> 명시적인 Oracle 파라미터 힌트와 Thin 모드 node-oracledb로 SQLBraid에 연결합니다.

SQLBraid Oracle 패키지와 드라이버를 함께 설치합니다.

```bash
npm install sqlbraid oracledb
```

이식 가능한 루트 패키지는 `oracledb`를 가져오지 않습니다. Node 어댑터는 드라이버 서브패스가 소유합니다.

```ts
import oracledb from "oracledb";
import { createOracledbDatabase, oracleParameter, sql } from "sqlbraid/oracledb";

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

Thin 바인딩 어댑터는 논리 문장을 text-positional `:1`, `:2`, … 바인드로
구체화하고 지원되는 힌트를 node-oracledb descriptor로 매핑합니다. 설명,
힌트 검증, 결정적 바인드 구성은 lease를 얻기 전에 수행됩니다. 어댑터는
드라이버 소유 유효 reuse를 보고하며, 지원하지 않는 힌트 속성은 DB I/O 전
`materialize` 단계에서 실패합니다.

## 기능 경계

- 첫 번째 대상은 `node-oracledb` Thin 모드입니다. Thick 모드는 이 문서의
  검증 범위 밖입니다.
- `sql.call`은 scalar OUT/IN OUT descriptor와
  `oracleParameter.refCursor()`를 사용하는 `SYS_REFCURSOR` OUT을 지원합니다.
  Cursor output은 materialized `resultSets`가 되고 scalar `output`에서
  제거됩니다. implicit result도 포함하며 lease 반환 전에 모든 `ResultSet`을
  닫습니다.
- 이 어댑터는 native `procedure` metadata를 지원하지 않습니다. Oracle
  PL/SQL/SQL 호출 텍스트를 명시적으로 작성하세요.
- 스트리밍은 드라이버의 ResultSet 프로토콜을 사용하며 완료, 중단, 조기 종료 시 ResultSet을 닫습니다.
- Cancellation은 guarded `connection.break()` 경로를 사용합니다. 이는 즉시
  중단이나 timeout을 보장하지 않는 cooperative 동작입니다. 문서화된
  `DBMS_SESSION.SLEEP` raw probe는 sleep이 끝날 때만 `ORA-01013`으로
  거부될 수 있으며, 어댑터는 settlement까지 물리 lease를 유지합니다.
  문서화된 break primitive가 없으면 active cancellation은 I/O 전에
  `BRAID_CANCEL_UNSUPPORTED`로 실패합니다.
- 대상 조합은 Node 22.18.0/Linux x64의 Oracle Free 23.9 Thin입니다.
  현재 인증 상태와 정확한 gate는 [런타임 및 드라이버
  지원](/SQLBraid/v/1.0.1/reference/support.md)에서 확인하세요.

드라이버가 안전한 Oracle 타입을 추론할 수 없는 `null`에는 명시적인 힌트를 사용하세요. 타입이 지정되지 않은 null을 조용히 `VARCHAR2`로 바꾸지 않습니다.

기본 정책은 정확한 `NUMBER` 계열(Oracle `FLOAT`와 ANSI numeric 별칭 포함)
결과를 정밀도 보존을 위해 string으로 가져옵니다. Oracle `NUMBER(p,0)`도 이
exact-decimal family에 속하며 support taxonomy는 별도의 native exact-integer
transport category를 만들지 않습니다. `NUMBER` decimal-string
입력은 인증된 exact bind 경로가 아닙니다. typed `number`/`bigint` 입력은
JavaScript 표현 범위에 묶이고, 힌트 없는 string은
`NLS_NUMERIC_CHARACTERS`에 의존할 수 있습니다. session/profile이 이를
증명하지 않는 한 unsupported로 유지하고, 필요하면 일반 character bind와
명시적이고 통제된 SQL 변환을 사용하세요.

Thin 어댑터는 precision/scale 속성과 IN 길이 제약을 거부합니다.
VARCHAR2/NVARCHAR2 OUT/INOUT 길이는 드라이버의 `maxSize`를 지정하며
다른 길이 속성은 거부합니다. DB 제약은 SQL이나 스키마에 선언하세요.
구체화된 CLOB/NCLOB는 문자열, BLOB/RAW는 버퍼입니다. 루틴 LOB output은
`oracleParameter.clob()`/`blob()`을 사용한 IN 및 IN OUT bind에서 드라이버의
LOB carrier를 받으며, OUT 및 IN OUT 결과는 정리 전에 구체화됩니다.
`getData()`로 읽고 lease 반환 전에 destroy 완료를 기다립니다. 읽기 실패 시
아직 방문하지 않은 sibling 리소스도 정리합니다. 시간 값은 `Date`를 사용하는
guarded 편의 프로필이며 원래 timezone 이름이나 sub-millisecond precision을
보존하지 않습니다. lossless text 경로에는 사용자가 작성한 `TO_CHAR`/format
표현식을 사용하세요. Native JSON은 parsed 편의 값이며 직렬화된 text가
필요하면 테스트한 fetch handler 또는 `JSON_SERIALIZE(... RETURNING CLOB)`를
사용합니다.

실행 가능한 LOB 감사는 `oracle.routine.inout` support fixture에서 CLOB/BLOB
OUT 및 IN OUT bind의 구체화와 정리를 검증합니다. target manifest에서 해당
테스트와 정확한 Oracle Free 증거를 확인할 수 있습니다.
이 fixture는 실제 Oracle Free 통합 테스트입니다. 별도의 mock LOB carrier
adapter unit coverage는 cleanup/error 경로만 검증하며 다른 database나
driver target을 승격하지 않습니다.

전체 `sql.out`/`sql.inOut` 및 이질적 result-set 계약은
[루틴 호출](/SQLBraid/v/1.0.1/concepts/routines.md)을 참고하세요.

## Oracle Thin 표현 프로필

첫 번째 프로필은 node-oracledb Thin 모드입니다. 현재 문서의 free Oracle
23.9 target을 Oracle 19c 증거로 표현해서는 안 됩니다. Thick 모드나 다른
server line은 일치하는 manifest 증거가 생길 때까지 별도의 미테스트
프로필입니다.

| Oracle 값                              | Driver raw / SQLBraid canonical 표현 | 비고                                                                                                                               |
| -------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NUMBER` / `FLOAT` / ANSI numeric 별칭 | text → `string`                      | `NUMBER(p,0)`을 포함하는 하나의 exact-decimal family이며 `decodeExactDecimal` 또는 `decodeExactInteger`는 애플리케이션 변환입니다. |
| `BINARY_FLOAT` / `BINARY_DOUBLE`       | JavaScript number                    | 근사 binary32/binary64 값이며 특수 값 지원은 프로필 테스트에 따릅니다.                                                             |
| CLOB / NCLOB                           | string                               | Routine LOB는 lease 반환 전에 읽고 destroy합니다.                                                                                  |
| BLOB / RAW                             | `Buffer`                             | byte로 유지하거나 명시적으로 encode합니다.                                                                                         |
| DATE / TIMESTAMP variant               | `Date`                               | Guarded 편의 프로필이며 fractional/zone 정확도에는 `TO_CHAR` text를 작성합니다.                                                    |
| Native JSON                            | parsed object                        | 편의 기능일 뿐 중첩 숫자 정확도를 보장하지 않습니다.                                                                               |

바인드 전송은 node-oracledb bind descriptor와 text-positional
`:1`, `:2`, …입니다. OUT ordinal은 중간 IN 값과 무관하게 SQL bind 순서를
따릅니다. REF CURSOR output은 순서가 있는 materialized `resultSets`가 되고
implicit result는 추가 set이 됩니다. Native `RETURNING ... INTO`는
`sql.out()`과 materialized row API를 사용합니다. Manifest가 증명한 경우
`executeMany()`가 native bulk 전략입니다. `rowsAffected`는 safe-range 검사를
하는 운영 count이고 `RETURNING INTO` 값은 동일한 exact string 계약을
따릅니다. 일반 `undefined` IN 값은 acquisition 전에
`BRAID_BIND_VALUE_UNSUPPORTED`로 실패하며 `null`은 SQL `NULL`입니다. Native
Oracle SQL은 투명하게 전달되지만 SQLBraid가 Oracle grammar를 제공하거나
procedure metadata를 추론하지는 않습니다.
