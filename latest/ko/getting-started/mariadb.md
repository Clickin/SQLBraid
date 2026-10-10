# MariaDB 빠른 시작

> MariaDB 문법을 명시적으로 쓰면서 SQLBraid를 MariaDB Connector/Node.js에 연결합니다.

SQLBraid 런타임 파사드와 공식 Connector/Node.js 드라이버를 설치하세요.

```bash
npm install sqlbraid mariadb
```

연결된 커넥션이나 명시적인 풀 팩토리와 함께 `/mariadb` 어댑터 하위 경로를 쓰세요.

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

방언은 `mysql`이 아니라 `mariadb`입니다. MariaDB 전용 문법은 SQL에 직접 씁니다. 현재 기능 검증 픽스처는 문서에 나온 `INSERT ... RETURNING`, `DELETE ... RETURNING`, `REPLACE ... RETURNING`, 시퀀스, CTE, JSON 함수를 다룹니다.

- `UPDATE ... RETURNING`은 지원한다고 주장하지 않습니다.
- `INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING` 형태는 해당 서버의 근거가 있어야 지원 목록에 오릅니다.

어댑터는 Connector/Node.js의 값 전용 실행, 네이티브 행 스트리밍, 그리고 `db.bulk()`를 위한 `connection.batch()` 호출 한 번(`native-bulk`)을 씁니다. 루트 벌크는 트랜잭션이 아니며, 자동 분할에 대한 공통 보장도 없습니다. 콜백 단위의 원자성이 필요하면 `db.tx()`를 쓰세요.

`mysql2` 커넥션도 최선 노력 수준의 호환으로 MariaDB에서 동작할 수 있습니다. 하지만 MariaDB 프로토콜에 대한 근거는 되지 않습니다. 공식 인증 프로필은 MariaDB 11.8.9 / Connector 3.5.4 / Node 22.18.0입니다. [런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)는 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합마다 등급을 기록하고, 해당 리비전과 워크플로 근거를 함께 남깁니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다.

## Connector/Node.js 표현 방식 프로필

공식 MariaDB 프로필은 `mariadb-lossless-text`입니다. 공식 Connector/Node.js 어댑터에 `representationProfiles` 설명 객체가 고른 옵션을 정확히 적용한 구성입니다.

- `@sqlbraid/mariadb`는 `typePolicyForProfile({ json, temporal })`을 export합니다. 그래서 런타임과 코드 생성이 변경할 수 없는 TypePolicy 하나를 공유합니다.
- `mariadb-native`는 별도의 편의 프로필입니다.
- MariaDB에 연결한 mysql2 커넥션은 별도의 최선 노력 호환 프로필입니다.

Connector/Node.js는 실제 적용된 옵션을 노출하지 않습니다. 설명 객체를 생략하거나 옵션을 일부만 선언하면 어댑터는 `mariadb-custom-profile`을 보고합니다. 이것은 인증된 프로필이 아닙니다. 명시적인 설명 객체도 관찰 결과가 아니라 guarded 선언으로 남습니다.

| MariaDB 값                  | 드라이버 원시 값 / SQLBraid 정규 표현      | 주의 사항                                                                                    |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| TINYINT/SMALLINT/INT/BIGINT | 드라이버에 따라 다름 → `string`            | 정확한 정수 결과는 정규 텍스트입니다. `decodeExactInteger`는 애플리케이션이 선택해서 씁니다. |
| DECIMAL/NUMERIC             | 텍스트 → `string`                          | 정확한 정밀도와 스케일이 텍스트로 유지됩니다. 필요하면 애플리케이션에서 소수 변환을 쓰세요.  |
| FLOAT/DOUBLE                | number → `number`                          | 근사 이진 값은 JavaScript 숫자로 남습니다.                                                   |
| JSON 별칭                   | `autoJsonMap:false`일 때 텍스트 → `string` | `autoJsonMap:true`는 별도의 편의 프로필이며 중첩된 숫자의 정확도를 보장하지 않습니다.        |
| DATE/TIME/DATETIME          | `dateStrings:true`일 때 텍스트 → `string`  | 네이티브 `Date`는 별도의 편의 프로필이며 소수 초나 시간대 정보를 잃을 수 있습니다.           |
| BLOB                        | 바이트/Buffer                              | 바이트를 그대로 유지하거나 명시적으로 인코딩하세요.                                          |

- 어댑터는 값 전용 실행, 네이티브 `queryStream()`, 그리고 같은 형태의 벌크를 위한 `connection.batch()` 호출 한 번을 씁니다.
- `queryStream()`은 텍스트 프로토콜로 값을 보냅니다. 그래서 `db.stream()`은 `null`, 문자열, 유한한 숫자, boolean, bigint, 유효한 `Date`, 바이너리 데이터만 받습니다. 배열, 객체, 유한하지 않은 숫자는 connector에 넘기기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 거부합니다. JSON 값은 `JSON.stringify()`로 인코딩하세요.
- 네이티브 `RETURNING`은 해당 서버 형태에 근거가 있을 때만 메모리로 읽는 행 선언으로 씁니다. `INSERT`, `DELETE`, `REPLACE`는 각각 별도의 기능입니다. `UPDATE`는 지원한다고 주장하지 않습니다.
- SQL은 바뀌지 않고 그대로 전달됩니다. MariaDB 문법을 지원한다는 뜻은 아닙니다.
- `db.call()`은 준비된 문장 `CALL`이 출력하는 서로 다른 결과 집합을 메모리로 읽습니다. OUT, INOUT, 커서 설명은 지원하지 않습니다.
- `db.prepare()`는 쿼리에 연결한 Standard Schema 매핑을 유지합니다.
- 선택 사항인 `/inspector` 하위 경로는 오프라인 `generateModels()`를 위해 identity, 생성 열·쓰기 플래그, 숫자 정밀도와 스케일을 기록합니다. 루틴 시그니처는 불완전한 긍정적 근거로 남습니다.

`mariadb-lossless-text` 설명 객체는 `bigIntAsNumber: false`, `decimalAsNumber: false`, `insertIdAsNumber: false`, `autoJsonMap: false`, `dateStrings: true`, `timezone: "Z"`를 유지합니다.

- 정확한 정수·소수 문자열은 execute, 준비된 쿼리, 검증된 벌크 방식에서 값을 정확하게 왕복시키는 바인딩 경로입니다.
- `affectedRows`는 안전한 범위인지 검사한 작업 개수입니다.
- 일반 IN 값이 `undefined`이면 리스를 획득하기 전에 `BRAID_BIND_VALUE_UNSUPPORTED`로 실패합니다. `null`은 SQL `NULL`입니다.
- Connector 3.5.4의 공개 타입 정의에는 `jsonStrings` 옵션이 없습니다. 그래서 텍스트를 받으려면 `autoJsonMap: false`를 쓰세요. 이것을 mysql2 프로필이라고 설명하지 마세요.
