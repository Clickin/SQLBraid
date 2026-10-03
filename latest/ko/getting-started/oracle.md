# Oracle 빠른 시작

> Oracle 파라미터 힌트를 명시하면서 SQLBraid를 Thin 모드의 node-oracledb에 연결합니다.

SQLBraid 런타임 파사드와 Oracle 드라이버를 함께 설치하세요.

```bash
npm install sqlbraid oracledb
```

방언 루트는 `oracledb`를 import하지 않습니다. Node 어댑터는 드라이버 하위 경로에 있습니다.

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

`sql.bind`는 값을 SQL 텍스트와 분리한 채 Oracle 데이터베이스 파라미터 타입을 지정합니다. 힌트가 없으면 어댑터는 문서에 나온 드라이버 추론을 씁니다. SQLBraid는 TypeScript의 `number`, `string`, `Date`를 Oracle 타입의 근거로 쓰지 않습니다.

Thin 바인딩 어댑터는 논리 문장을 텍스트·위치 기반 `:1`, `:2`, … 바인딩으로 바꿉니다. 지원하는 힌트는 node-oracledb 설명 객체로 매핑합니다. 설명, 힌트 검증, 결정적인 바인딩 구성은 리스를 획득하기 전에 일어납니다. 어댑터는 드라이버가 맡는 실제 재사용 방식을 보고합니다. 지원하지 않는 힌트 속성은 데이터베이스 I/O 전에 `materialize` 단계에서 실패합니다.

## 기능 경계

- 공식 대상은 `node-oracledb` Thin 모드입니다. Thick 모드는 이 가이드의 검증 범위가 아닙니다.
- `sql.call`은 스칼라 OUT·IN OUT 설명과, `oracleParameter.refCursor()`를 쓴 `SYS_REFCURSOR` OUT 값을 지원합니다. 커서 출력은 메모리로 읽은 `resultSets`가 되고, 스칼라 `output`에서 빠집니다. 암시적 결과도 포함됩니다. 모든 `ResultSet`은 리스 반환 전에 닫힙니다.
- 이 어댑터는 네이티브 `procedure` 메타데이터를 지원하지 않습니다. Oracle PL/SQL이나 SQL 호출 텍스트를 직접 쓰세요.
- 스트리밍은 드라이버의 ResultSet 프로토콜을 씁니다. 완료, 중단, 반복 조기 종료 시 ResultSet을 닫습니다.
- 취소는 guarded 상태의 `connection.break()` 경로를 씁니다. 협력적인 방식이라 즉시 멈추거나 시간 제한을 지킨다고 보장하지 않습니다. 문서화된 `DBMS_SESSION.SLEEP` 원시 점검은 sleep이 끝날 때만 `ORA-01013`으로 reject될 수 있습니다. 어댑터는 결과가 확정될 때까지 물리 리스를 붙잡고 있습니다. 문서화된 break 기능이 없으면 활성 취소는 I/O 전에 `BRAID_CANCEL_UNSUPPORTED`로 실패합니다.
- 대상 조합은 Node 22.18.0/Linux x64의 Oracle Free 23.9 Thin입니다. 현재 인증 상태와 정확한 게이트는 [런타임·드라이버 지원](/SQLBraid/latest/reference/support.md)에 있습니다.

드라이버가 안전한 Oracle 타입을 추론할 수 없다면 `null`에 힌트를 명시하세요. 타입 없는 null을 몰래 `VARCHAR2`로 바꾸지 마세요.

기본 정책은 정밀도를 지키기 위해 정확한 `NUMBER` 계열을 문자열로 가져옵니다. Oracle `FLOAT`와 ANSI 숫자 별칭도 포함됩니다. Oracle `NUMBER(p,0)`도 이 정확한 소수 계열에 속합니다. 지원 분류 체계는 네이티브 정확한 정수 전송을 위한 별도 범주를 만들지 않습니다.

`NUMBER`에 소수 문자열을 입력하는 경로는 인증된 정확한 바인딩 경로가 아닙니다.

- 타입이 지정된 `number`와 `bigint` 입력은 JavaScript 표현의 한계를 따릅니다.
- 힌트 없는 문자열은 `NLS_NUMERIC_CHARACTERS`에 따라 달라질 수 있습니다.

세션이나 프로필이 증명하지 않는 한, 이 기능은 미지원으로 두세요. 필요하면 일반 문자 바인딩과 통제된 명시적 SQL 변환을 쓰세요.

Thin 어댑터는 정밀도·스케일 속성과 IN 길이 제약을 거부합니다. VARCHAR2와 NVARCHAR2의 OUT·INOUT 길이는 드라이버의 `maxSize`를 정합니다. 다른 길이 속성은 거부합니다. 데이터베이스 제약은 SQL이나 스키마에 두세요.

- 메모리로 읽은 CLOB·NCLOB 값은 문자열, BLOB·RAW 값은 버퍼입니다.
- `oracleParameter.clob()`과 `blob()`은 IN·IN OUT 바인딩에 드라이버의 LOB 객체를 받습니다. OUT·IN OUT 결과는 정리 전에 메모리로 읽습니다.
- 루틴의 LOB 출력은 `getData()`로 읽고 리스 반환 전에 해제합니다. 읽기 실패 후 아직 처리하지 않은 나머지 LOB도 마찬가지입니다.
- 날짜·시간 값은 guarded 편의 프로필인 `Date`를 씁니다. 원본 시간대 이름이나 밀리초 미만 정밀도는 유지하지 않습니다. 무손실 텍스트 경로가 필요하면 SQL에 `TO_CHAR`나 포맷 식을 쓰세요.
- 네이티브 JSON은 파싱된 편의 값입니다. 직렬화된 텍스트가 필요하면 검증된 fetch 핸들러나 `JSON_SERIALIZE(... RETURNING CLOB)`를 쓰세요.

실행 가능한 LOB 검증은 `oracle.routine.inout` 지원 픽스처에서 CLOB·BLOB의 OUT·IN OUT 바인딩, 메모리 읽기, 정리를 다룹니다. 대상 매니페스트는 이 테스트와 정확한 Oracle Free 근거를 연결합니다. 이 픽스처는 실제 Oracle Free 통합 테스트입니다. 모의 LOB 객체를 쓰는 별도의 어댑터 단위 테스트는 정리와 오류 경로만 확인하며, 다른 데이터베이스나 드라이버 대상의 등급을 올리지 않습니다.

`sql.out`/`sql.inOut`과 여러 결과 집합에 대한 전체 규칙은 [루틴 호출](/SQLBraid/latest/concepts/routines.md)을 보세요.

## Oracle Thin 표현 방식 프로필

공식 프로필은 node-oracledb Thin 모드입니다. 현재 문서화된 환경은 무료 Oracle 23.9 대상입니다. 이것을 Oracle 19c 근거로 내세우지 마세요. Thick 모드와 다른 서버 버전은 매니페스트에 맞는 근거가 생기기 전까지 테스트되지 않은 별도 프로필입니다.

| Oracle 값                           | 드라이버 원시 값 / SQLBraid 정규 표현 | 참고                                                                                                                           |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NUMBER` / `FLOAT` / ANSI 숫자 별칭 | 텍스트 → `string`                     | `NUMBER(p,0)`를 포함한 하나의 정확한 소수 계열입니다. `decodeExactDecimal`이나 `decodeExactInteger`는 애플리케이션 변환입니다. |
| `BINARY_FLOAT` / `BINARY_DOUBLE`    | JavaScript number                     | 근사 binary32/binary64 값입니다. 특수 값 지원은 프로필별로 테스트합니다.                                                       |
| CLOB / NCLOB                        | string                                | 루틴 LOB은 리스 반환 전에 읽고 해제합니다.                                                                                     |
| BLOB / RAW                          | `Buffer`                              | 바이트를 그대로 유지하거나 명시적으로 인코딩하세요.                                                                            |
| DATE / TIMESTAMP 계열               | `Date`                                | guarded 편의 프로필입니다. 소수 초나 시간대 정확도가 필요하면 `TO_CHAR` 텍스트를 직접 쓰세요.                                  |
| 네이티브 JSON                       | 파싱된 객체                           | 편의 기능일 뿐이며, 중첩된 숫자의 정확도는 보장하지 않습니다.                                                                  |

- 바인딩 전송 방식은 node-oracledb 바인딩 설명을 쓰는 텍스트·위치 기반 `:1`, `:2`, …입니다.
- OUT 순번은 SQL의 바인딩 순서를 따릅니다. 사이에 있는 IN 값이 순번을 바꾸지 않습니다.
- REF CURSOR 출력은 순서가 있는, 메모리로 읽은 `resultSets`가 됩니다. 암시적 결과는 추가 집합입니다.
- 네이티브 `RETURNING ... INTO`는 `sql.out()`과 메모리로 읽는 행 API를 씁니다.
- 매니페스트가 증명하는 곳에서는 `executeMany()`가 지원되는 네이티브 벌크 방식입니다.
- `rowsAffected`는 안전한 범위를 검사한 작업 개수입니다. `RETURNING INTO` 값도 같은 정확한 문자열 규칙을 따릅니다.
- 일반 IN 값이 `undefined`이면 리스를 획득하기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
- 네이티브 Oracle SQL은 바뀌지 않고 그대로 전달됩니다. SQLBraid는 Oracle 문법을 제공하지 않고, 프로시저 메타데이터를 추론하지도 않습니다.
