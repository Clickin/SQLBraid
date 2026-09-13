---
title: 드라이버 작성자 바인딩 가이드
description: 값 전용 보안 경계를 지키는 사용자 지정 SQLBraid 바인딩 어댑터를 구현합니다.
---

이 문서는 사용자 지정 `QueryExecutor`, `ConnectionProvider`, 드라이버 어댑터를 위한 것입니다. PV15 최종 검증은 대기 중이며 현재 CI·SHA·런타임 지원 label·배포 증거를 주장하지 않습니다.

## 논리 문장 불변식

Core/template 렌더링은 하나의 불변 `RenderedStatement`를 반환합니다.

```ts
interface RenderedParameter {
  readonly value: unknown;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
  readonly direction?: "in" | "out" | "inout";
  readonly outputName?: string;
}

interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: QueryResultKind;
  readonly dialectId: string;
  readonly routineProcedure?: {
    readonly name: string;
    readonly parameterNames: readonly string[];
  };
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1`이 필수입니다. `segments`에는
`@braid`, `sql.ident`, `sql.raw`, fragment, list, join, trim의 구조적 결정이
이미 반영되어 있습니다. 모든 parameter는 값입니다. 드라이버는 이를 SQL,
식별자, nested query, driver fragment, native tagged-template command로 다시
해석하면 안 됩니다. 사용자 지정 공개 경계에서는 `createRenderedStatement`를
사용하고 별도의 mutable text/values/hints/maps를 실행 원본으로 유지하지 마세요.

## 바인딩 어댑터

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(
    statement: RenderedStatement,
    context: StatementBindingContext,
  ): StatementBindingDescription;
}

interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
```

`StatementBindingDescription.bindings`는 `index`, 선택적 driver `name`,
보간 인덱스, 선택적 hint, 방향, output 이름을 가진 불변 메타데이터입니다.
애플리케이션 값은 노출하지 않으며 인코딩된 불투명 request는 드라이버 내부에
보관합니다.

`describe()`는 DB에 대해 순수해야 합니다. `native-value-template`,
`text-positional`, `text-named`, `typed-request` 중 전송을 선택하고, 힌트를
검증하고, 연결을 얻기 전에 결정적인 typed request를 구성합니다. 이 단계의
실패는 실행 플래그가 모두 false인 `materialize` 오류입니다. 드라이버·서버·
네트워크 실패는 `driver` 오류입니다.

Provider와 모든 lease는 같은 어댑터 객체를 노출해야 합니다.

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
```

`query`, `call`, `stream`에 동일한 선택적 `StatementBindingDescription`을
전달하여 드라이버가 인코딩을 반복하지 않게 하세요. 불투명한 request는
드라이버 패키지 내부에 두고, 필요하면 description을 키로 하는 `WeakMap`을
사용하세요.

## 완전한 사용자 지정 어댑터 예시

```ts
import {
  createRenderedStatement,
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type QueryExecutionResult,
  type QueryExecutor,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
  type StatementBindingDescription,
} from "@sqlbraid/core";

interface WireClient {
  execute<Row>(sql: string, values: readonly unknown[]): Promise<QueryExecutionResult<Row>>;
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

const requests = new WeakMap<StatementBindingDescription, {
  readonly statement: RenderedStatement;
  readonly sql: string;
  readonly values: readonly unknown[];
}>();

export const acmeStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    for (const parameter of statement.parameters) {
      if (parameter.hint !== undefined) throw new Error("BRAID_BIND_HINT_UNSUPPORTED");
    }
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder: (index) => `$${index}`, // 1부터 시작
      reuse: {
        effective: "simple",
        owner: "driver",
      },
    });
    const text = description.parameterizedSql;
    if (text === undefined) throw new Error("BRAID_BIND_TRANSPORT");
    requests.set(description, {
      statement,
      sql: text,
      values: statement.parameters.map((parameter) => parameter.value),
    });
    return description;
  },
});

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeStatementBinding,
    async query<Row>(statement: RenderedStatement, binding?: StatementBindingDescription) {
      statement = createRenderedStatement(statement);
      const description = binding ?? acmeStatementBinding.describe(statement, {
        dialectId: statement.dialectId,
        requestedReuse: "auto",
      });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new Error("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.sql, request.values);
    },
  };
}

export function createAcmeProvider(
  acquireClient: () => Promise<WireClient>,
): ConnectionProvider {
  return {
    statementBinding: acmeStatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const client = await acquireClient();
      const executor = createAcmeExecutor(client);
      let released = false;
      return {
        ...executor,
        async release(options) {
          if (released) return;
          released = true;
          await client.release(options);
        },
      };
    },
  };
}
```

Typed request 전송은 `p1`, `p2`, … 이름, 지원하는 힌트별 driver type,
facet 검증, 인코딩된 값을 내부 request에 보관합니다. Native value-template은
value-only native API만 사용하고, 구조로 처리될 수 있는 다형성 tag에 논리
parameter를 넘기지 마세요.

## 다섯 전송 경로

| 경로 | 전송과 구체화 | reuse 소유자 |
| --- | --- | --- |
| PostgreSQL / `pg` | `text-positional`, `$1..$N` | fresh unnamed simple, driver |
| MySQL / `mysql2` | `text-positional`, `?` | 모든 요청에서 driver reuse |
| SQLite / `node:sqlite` | 문서화된 `DatabaseSync.prepare(text)`와 `?` | fresh simple, driver |
| Oracle Thin / `node-oracledb` | `text-positional`, `:1..:N`, bind descriptor | driver cache reuse |
| SQL Server / Tedious | `typed-request`, `@p1..@pN`, `TYPES.*`, facet | fresh Request/`execSql`, simple, driver |

`auto`, `simple`, `reuse`는 논리 요청이고 유효 정책은 어댑터가 보고합니다.
요청만 보고 유효 정책을 추론하면 안 됩니다. Prepared shape는 결과 종류 +
정규화된 segments + 순서가 있는 hint 시그니처이며 placeholder 표기는 포함하지
않습니다. Prepared factory는 한 번 렌더링합니다. 런타임에 범용 statement
cache를 추가하지 마세요.

## 루틴·stream·lease 경계

`QueryExecutor.stream`은 `all()` buffer가 아닌 실제 드라이버 경로로
구현하세요. 물리적 lease를 반환하거나 폐기하기 전에 드라이버
cursor/request/iterator를 close, drain 또는 cancel해야 합니다.
`QueryExecutor.call`은 `{ output, resultSets, returnValue? }` 정규화 결과를
반환하며 모든 cursor/ResultSet을 소비합니다. raw 드라이버 객체는 애플리케이션
결과로 보내지 마세요. Cursor OUT은 scalar `output`이 아니라 `resultSets`에
들어갑니다. PostgreSQL refcursor는 기존 transaction이 필요하며 안전한
carrier를 증명할 수 없는 MySQL prepared CALL OUT/INOUT과 SQL Server cursor
output은 명시적으로 실패해야 합니다.

## 힌트·provider·observer 규칙

지원하는 힌트는 모두 적용하고, 나머지는 I/O 전에 거부하세요. 조용히
무시하지 마세요. null, 숫자, temporal, binary, facet, recordset, ResultSet 및
지원하지 않는 call 동작을 각 드라이버 정책대로 보존합니다. Provider와 lease의
바인딩 identity를 같게 하고, materialized mapping 전에는 lease를 반환하며,
stream이 닫힐 때까지 stream lease를 유지하세요.

`query:ready`는 acquire 전에 읽기 전용 `{ adapterId, dialectId, transport, reuse }`
계획을 노출합니다. `literalizedSql(options?)`는 지연 계산·캐시되고 기본은
redacted입니다. 논리 segments와 parameters에서
`segment[0] + literal(parameter[0]) + ...`를 직접 구성하며 placeholder를
치환하지 않습니다. 실행 입력으로 사용할 수 없습니다. 최대 길이, binary
summary/full, 사용자 redactor와 `complete`, `redactedParameters`,
`truncatedParameters` 집계를 지원하고 지원하지 않는 객체는 안전한 marker로
표시하세요.

## Native value 보안 conformance

재사용 가능한 어댑터 테스트에 다음 negative fixture를 포함하세요.

```ts
const nativeFragment = { kind: "native-sql-fragment", text: "DROP TABLE accounts" };
const statement = render(sql`SELECT ${nativeFragment}`);
const description = acmeStatementBinding.describe(statement, {
  dialectId: "acme-sql",
  requestedReuse: "auto",
});

// parameter 하나가 값으로 남고 fragment text는 segments에 들어가지 않습니다.
// materialization은 nativeFragment를 값으로 보내거나 거부해야 합니다.
```

하나의 adapter 객체를 여러 dialect context에서 설명하는 conformance도
검증하세요. context가 driver 정책이나 진단 literal 형식을 바꿀 수는 있지만
core의 value-only 불변식은 바꾸면 안 됩니다. 구조적 경로는 `sql.raw`,
`sql.ident`, 명시적 fragment helper뿐입니다.

전체 계약과 체크리스트는 [영문 driver-author guide](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md)를 참고하세요.
