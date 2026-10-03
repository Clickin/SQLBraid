# 루틴 호출

> 출력 값, 반환 값, 서로 다른 결과 집합을 명시적으로 선언하고 저장 프로시저를 호출합니다.

데이터베이스 루틴이 일반 행 조회보다 많은 채널을 가진다면 `sql.call`을 쓰세요. 호출 결과에는 서로 독립된 채널이 세 개 있습니다.

- `output`: 이름이 있는 스칼라 OUT·INOUT 값
- `resultSets`: 순서가 있고 메모리로 모두 읽은 행 집합. 집합마다 행 타입이 다를 수 있습니다.
- `returnValue`: 드라이버가 제공하는 경우, 루틴의 반환 값이나 상태 값 (선택 사항)

일반 행 작업은 결과 집합을 하나만 받습니다. `db.all`, `db.one`, `db.maybeOne`, 일반 `db.execute`는 행 결과 집합을 최대 하나까지만 허용합니다. 여러 결과 집합은 `db.call`로 명시적으로 다룹니다. `db.call`은 순서가 있는 루틴 결과 집합 여러 개를 반환합니다.

## 애플리케이션 결과 선언하기

쿼리 경계에 Standard Schema 검증기를 연결하세요.

```ts
import { mssqlParameter, sql } from "sqlbraid/mssql";

const refresh = sql.call({
  procedure: {
    name: "dbo.refresh_accounts",
    parameterNames: ["accountId", "generatedAt"],
  },
  output: OutputSchema,
  resultSets: [UserSchema, PaymentSchema] as const,
  returnValue: ReturnCodeSchema,
})`
  ${accountId} ${sql.out("generatedAt", mssqlParameter.datetime2())}
`;

const result = await db.call(refresh);
result.output.generatedAt;
result.resultSets[0].rows[0]; // UserSchema output
result.resultSets[1].rows[0]; // PaymentSchema output
result.returnValue;
```

`resultSets`는 튜플 선언입니다. 실제 개수와 선언한 개수가 같아야 합니다. 각 행은 같은 위치의 스키마로 매핑됩니다. 쿼리에 스키마를 연결할 필요가 없다면 선언 없이 `sql.call\`...\``을 써도 됩니다. 런타임 매핑은 어댑터가 메모리로 읽은 루틴 리소스를 모두 읽고 닫은 뒤에 실행됩니다. 그래서 비동기 스키마 매퍼가 데이터베이스 리스를 붙잡고 있지 않습니다.

결과 집합 선언이 없는 루틴 호출도 `resultSets`를 반환합니다. 행 하나짜리 제네릭으로 바뀌지 않습니다. 스칼라 커서 값은 `output`에 남지 않습니다.

## 파라미터 방향 표시하기

일반 보간은 IN 값입니다. 루틴 전용 헬퍼로 방향과 출력 이름을 명시합니다.

```ts
const call = sql.call({
  procedure: {
    name: "dbo.reconcile",
    parameterNames: ["accountId", "state", "message"],
  },
  output: OutputSchema,
})`
  ${accountId}
  ${sql.inOut("state", "pending", mssqlParameter.nvarchar(50))}
  ${sql.out("message", mssqlParameter.nvarchar(200))}
`;
```

- `sql.out(name, hint?)`는 논리적인 `null` 플레이스홀더를 씁니다.
- `sql.inOut(name, value, hint?)`는 초기값을 함께 넘깁니다.
- 출력 이름은 비어 있으면 안 되고 서로 달라야 합니다.
- `sql.rows`나 `sql.command`에서는 OUT·INOUT 파라미터가 데이터베이스 I/O 전에 거부됩니다. 방향을 지정해도 SQL 구조로 취급되지 않습니다.
- 데이터베이스가 타입 설명을 요구하면 어댑터의 힌트 팩토리를 쓰세요.
- 방향과 출력 이름은 준비된 쿼리의 형태에 포함됩니다.

PostgreSQL에서 `outputName`은 위치 기반 CALL 출력의 이름을 바꿉니다. 이름으로 출력 열을 고르는 것이 아닙니다. 데이터베이스의 다른 OUT 이름과 같더라도 마찬가지입니다.

## 결과 집합의 순서와 정리

정규화된 순서는 다음과 같습니다.

1. 명시적인 OUT/INOUT 커서 결과 집합 (파라미터 순서)
2. 암시적 결과 집합 (드라이버 순서)
3. SELECT가 출력한 결과 집합 (드라이버 순서)

출력된 결과 집합만 제공하는 어댑터는 서버 순서대로 반환합니다. SQLBraid는 각 결과 집합을 가져오거나 끝까지 비웁니다. 커서, ResultSet, 요청 리소스를 모두 닫은 다음에야 물리 리스를 반환하거나 폐기합니다. `db.all()`은 일부러 버퍼링하므로 행 수에 비례해 애플리케이션 메모리를 씁니다. 루틴 결과 집합도 같은 방식으로 명시적으로 메모리에 읽습니다. 원시 드라이버 객체, 포털 이름, 프로토콜 전달용 행은 애플리케이션 결과로 새어 나가지 않습니다.

Oracle의 CLOB·NCLOB 출력은 문자열이, BLOB 출력은 바이트가 됩니다. 어댑터는 반환된 Lob을 리스 반환 전에 읽고 해제합니다. 출력 하나가 실패해도 아직 처리하지 않은 나머지 Lob과 ResultSet을 닫습니다.

## 데이터베이스별 경계

| 데이터베이스                  | 루틴 동작                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`             | 스칼라 OUT 값은 `CALL` 출력 행에서 옵니다. refcursor OUT은 `postgresParameter.refcursor()`로 표시합니다. SQLBraid는 트랜잭션에 묶인 포털을 각각 가져와 닫고 `output`에서 뺍니다. INOUT과 refcursor INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. refcursor 호출에는 기존 `db.tx(...)` 범위가 필요하며, SQLBraid는 숨은 트랜잭션을 만들지 않습니다.                      |
| MySQL / `mysql2`              | SELECT가 출력하는 서로 다른 결과 집합을 지원합니다. 준비된 문장으로 실행한 CALL의 OUT/INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. mysql2 3.x에는 프로토콜의 추가 OUT 전달 행을 구분하는 검증된 공개 수단이 없어서, SQLBraid가 그 행을 추측하지 않습니다. 저장 함수는 결과 집합을 출력할 수 없습니다.                                                                  |
| MariaDB / Connector/Node.js   | SELECT가 출력하는 서로 다른 결과 집합을 지원합니다. 준비된 문장으로 실행한 CALL의 OUT/INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. Connector/Node.js는 준비된 문장 호출의 OUT 전달 방식을 검증된 공개 API로 제공하지 않습니다. 저장 함수는 결과 집합을 출력할 수 없습니다.                                                                                             |
| Oracle / `node-oracledb` Thin | 스칼라 OUT/IN OUT 바인딩, 명시적인 `SYS_REFCURSOR`/REF CURSOR 출력, 암시적 결과를 `output`과 `resultSets`로 정규화합니다. 열려 있는 `ResultSet`은 모두 리스 반환 전에 닫습니다. 커서 출력에는 `oracleParameter.refCursor()`를 쓰세요.                                                                                                                                        |
| SQL Server / Tedious          | 일반 SELECT는 출력된 결과 집합이 되고, 스칼라 OUTPUT 값은 `output`이 됩니다. T-SQL 정수 RETURN 상태를 받으려면 `sql.call` 선언에 `procedure: { name, parameterNames }` 메타데이터를 명시하세요. SQLBraid는 임의의 `EXEC` 텍스트를 파싱해 프로시저를 추측하지 않습니다. `CURSOR VARYING OUTPUT`은 애플리케이션 커서로 쓸 수 없어 거부합니다(`BRAID_CALL_CURSOR_UNSUPPORTED`). |
| SQLite 어댑터                 | `db.call()` / `routine.call`은 지원하지 않습니다. 이것은 어댑터 API의 경계이며 SQLite SQL에 대한 제한이 아닙니다. SQLite에 등록한 스칼라·집계·윈도 함수는 일반 SQL 안에서 쓰고, 가상 테이블·테이블 값 확장은 일반 `sql.rows(...)` 쿼리로 씁니다.                                                                                                                             |

네이티브 프로시저 메타데이터를 명시한 SQL Server 예제입니다.

```ts
const refresh = sql.call({
  procedure: {
    name: "dbo.refresh_accounts",
    parameterNames: ["accountId"],
  },
  resultSets: [AccountSchema] as const,
})`${accountId}`;
```

프로시저 메타데이터는 네이티브 드라이버로 바로 연결하는 명시적인 통로입니다. 범용 저장 프로시저 DSL이 아닙니다. 이름 목록의 순서는 호출 파라미터와 같아야 합니다. 네이티브 프로시저 메타데이터를 쓰면 템플릿에는 파라미터 보간, 공백, 쉼표만 들어갈 수 있고, 드라이버가 지정한 프로시저를 호출합니다. 따라서 `EXEC` 텍스트나 다른 SQL 텍스트는 무시되지 않고 I/O 전에 `BRAID_CALL_PROCEDURE_INVALID`로 거부됩니다.

## 루틴 스트리밍

SQLBraid는 메모리로 모두 읽는 `db.call()`만 제공합니다. `callStream()`은 이름만 예약되어 있고 구현되지 않았습니다. 1.0.0에서 호출할 수 있는 API가 아닙니다. 행을 만드는 일반 쿼리와 집합 반환 함수에는 `db.stream(sql.rows(...))`를 쓰세요. 루틴 커서 결과 집합은 독립된 행 스트림이 아닙니다.

[SQL 태그와 결과 종류](/SQLBraid/latest/concepts/sql-tags.md), [스트리밍](/SQLBraid/latest/runtime/streaming.md), [진단](/SQLBraid/latest/reference/errors.md)도 함께 읽어 보세요.
