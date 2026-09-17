---
title: 루틴 호출
description: 명시적인 output, return, 이질적인 result-set 계약으로 저장 프로시저 호출을 작성합니다.
---

일반 행 쿼리 이외의 채널이 있는 데이터베이스 루틴에는 `sql.call`을 사용하세요. 호출 결과에는 서로 독립적인 세 채널이 있습니다.

- `output`: 이름이 있는 scalar OUT/INOUT 값
- `resultSets`: 순서가 있는 materialized 행 집합. 각 집합은 서로 다른 행 타입일 수 있음
- `returnValue`: 드라이버가 노출하는 경우의 선택적 루틴 return/status 값

일반 행 작업은 단일 result-set 경계입니다. `db.all`, `db.one`,
`db.maybeOne`, 일반 `db.execute`는 최대 하나의 행 result set만 허용합니다.
`db.call`은 명시적인 다중 result-set 경계이며 순서가 있는 여러 루틴 result
set을 반환합니다.

## 애플리케이션 계약 선언

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
result.resultSets[0].rows[0]; // UserSchema 결과
result.resultSets[1].rows[0]; // PaymentSchema 결과
result.returnValue;
```

`resultSets`는 tuple 계약입니다. 실제 개수는 선언한 개수와 같아야 하며 각 행은 대응하는 schema로 매핑됩니다. 쿼리 경계 schema가 필요하지 않으면 bare `sql.call\`...\``도 사용할 수 있습니다. 런타임 매핑은 어댑터가 materialized 루틴 리소스를 모두 소비하고 닫은 뒤 실행되므로 async schema mapper가 데이터베이스 lease를 붙잡지 않습니다.

result-set 계약이 없어도 루틴 호출은 `resultSets`를 반환합니다. 단일 행 generic이 아닙니다. cursor scalar 값은 `output`에 남지 않습니다.

## 파라미터 방향 표시

일반 보간은 IN 값입니다. 루틴 전용 helper로 방향과 output 이름을 명시하세요.

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

`sql.out(name, hint?)`는 논리적인 `null` placeholder를 사용하며 `sql.inOut(name, value, hint?)`는 초기값을 전달합니다. output 이름은 비어 있지 않고 서로 달라야 합니다. `sql.rows` 또는 `sql.command`에서 OUT/INOUT을 사용하면 DB I/O 전에 거부됩니다. 방향은 구조적 SQL 의미를 부여하지 않습니다. 데이터베이스가 type descriptor를 요구하면 해당 어댑터의 hint factory를 사용하세요. 방향과 output 이름은 prepared shape identity에 포함됩니다.

PostgreSQL의 `outputName`은 파라미터 위치에 대응하는 CALL output의 논리적
이름입니다. 다른 DB OUT 이름과 같더라도 그 이름의 carrier 열을 선택하지 않습니다.

## Result-set 순서와 정리

정규화된 순서는 다음과 같습니다.

1. 파라미터 순서의 명시적 OUT/INOUT cursor result set
2. 드라이버 순서의 implicit result set
3. 드라이버 순서의 emitted SELECT result set

emitted 집합만 노출하는 어댑터는 서버 순서대로 반환합니다. SQLBraid는 모든 집합을 fetch/drain하고 모든 cursor/ResultSet/request 리소스를 닫은 뒤에만 물리적 lease를 반환하거나 폐기합니다. `db.all()`은 의도적으로 버퍼링하며 O(row-count) 애플리케이션 메모리를 사용합니다. 루틴 result set도 같은 명시적 materialization 규칙을 따릅니다. raw 드라이버 객체, portal 이름, protocol carrier 행은 애플리케이션 결과로 나가지 않습니다.

Oracle CLOB/NCLOB output은 문자열, BLOB output은 바이트 값이 됩니다.
반환된 Lob는 lease 반환 전에 읽고 destroy 완료를 기다립니다. 한 output이
실패해도 아직 방문하지 않은 sibling Lob와 ResultSet을 정리합니다.

## 데이터베이스별 경계

| 데이터베이스                  | 루틴 동작                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL / `pg`             | scalar OUT은 `CALL` output 행에서 나옵니다. refcursor OUT은 `postgresParameter.refcursor()`로 표시하세요. SQLBraid는 같은 transaction-bound portal을 fetch/close하고 이를 `output`에서 제거합니다. INOUT과 refcursor INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. refcursor 호출은 기존 `db.tx(...)` 범위가 필요하며 숨은 transaction을 만들지 않습니다.      |
| MySQL / `mysql2`              | emitted 이질적 SELECT result set을 지원합니다. prepared CALL OUT/INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. mysql2 3.x에는 protocol의 추가 OUT carrier를 구분하는 검증된 public API가 없으므로 SQLBraid는 carrier 행을 추측하지 않습니다. Stored function은 result set을 내보낼 수 없습니다.                                                                |
| MariaDB / Connector/Node.js   | emitted 이질적 SELECT result set을 지원합니다. prepared CALL OUT/INOUT은 `BRAID_CALL_OUT_UNSUPPORTED`로 거부합니다. Connector/Node.js에는 prepared call용 OUT 파라미터 carrier를 구분하는 공개 API가 없으므로 SQLBraid는 carrier 행을 추측하지 않습니다. Stored function은 result set을 내보낼 수 없습니다.                                                         |
| Oracle / `node-oracledb` Thin | scalar OUT/IN OUT, `SYS_REFCURSOR`/REF CURSOR output, implicit result를 `output`과 `resultSets`로 정규화합니다. lease를 반환하기 전에 모든 `ResultSet`을 닫습니다. cursor output에는 `oracleParameter.refCursor()`를 사용하세요.                                                                                                                                    |
| SQL Server / Tedious          | 일반 SELECT는 emitted result set이 되고 scalar OUTPUT은 `output`이 됩니다. T-SQL integer RETURN status는 `sql.call` 계약에 `procedure: { name, parameterNames }`를 명시해야 합니다. 임의 `EXEC` 텍스트를 파싱해 procedure identity를 추측하지 않습니다. `CURSOR VARYING OUTPUT`은 애플리케이션 cursor로 노출하지 않고 `BRAID_CALL_CURSOR_UNSUPPORTED`로 거부합니다. |
| SQLite adapter                | `db.call()` / `routine.call`은 지원하지 않습니다. 이는 adapter API 경계이며 SQLite SQL의 제한이 아닙니다. SQLite function API로 등록한 scalar/aggregate/window function은 일반 SQL 안에서 사용하며 virtual-table/table-valued extension은 일반 `sql.rows(...)` 쿼리입니다.                                                                                          |

명시적 SQL Server procedure metadata 예시입니다.

```ts
const refresh = sql.call({
  procedure: {
    name: "dbo.refresh_accounts",
    parameterNames: ["accountId"],
  },
  resultSets: [AccountSchema] as const,
})`${accountId}`;
```

procedure metadata는 명시적인 native-driver seam이지 일반 stored-procedure DSL이 아닙니다. 이름 순서는 호출 파라미터와 일치해야 합니다. native procedure metadata를 쓰면 template에는 파라미터 interpolation과 공백만 넣습니다. 드라이버가 명시한 procedure를 호출하므로 `EXEC` 텍스트는 무시하지 않고 거부합니다.

## 루틴 스트리밍

SQLBraid는 현재 결과가 모두 구체화(materialized)되는 `db.call()`만 제공합니다. `callStream()`은 예약된 미구현 이름이며 호출 가능한 1.0.0 API가 아닙니다. 일반 행 쿼리와 set-returning function에는 `db.stream(sql.rows(...))`를 사용하세요. 루틴 cursor result set은 독립적인 행 stream이 아닙니다.

[SQL 태그와 결과 종류](/SQLBraid/concepts/sql-tags/), [스트리밍](/SQLBraid/runtime/streaming/), [진단](/SQLBraid/reference/errors/)도 참고하세요.
