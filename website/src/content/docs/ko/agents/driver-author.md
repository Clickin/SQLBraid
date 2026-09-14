---
title: 드라이버 작성자 바인딩 가이드
description: 값 전용 경계를 지키는 사용자 지정 SQLBraid adapter를 구현합니다.
---

이 문서는 custom `QueryExecutor`, `ConnectionProvider`, binding adapter를
위한 현재 API 계약입니다. 지원 label이나 발행 증거를 부여하지 않습니다.
provenance로 보존하는 마지막 exact-SHA 검증은
`8da8167e027320fcc9bb2aac16b0903c64147940`이며 Runtime
[34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046),
Docs [34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102),
Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)가
성공했습니다. 현재 tree에는 새 exact-SHA gate가 필요합니다.

## 논리 statement 불변식

Core/template rendering은 하나의 불변 `RenderedStatement`를 반환합니다.

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly dialectId: string;
}
```

`segments.length === parameters.length + 1`입니다. 모든 parameter는 값이며
custom driver는 이를 SQL, identifier, nested SQL, native tagged-template
command로 재해석하면 안 됩니다. 구조는 `sql.ident`, `sql.fragment`,
`sql.raw`, `sql.list`, `sql.join` 같은 명시 helper로 작성되어 `segments`에
이미 들어 있습니다.

## Binding과 lease

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
}
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
interface ConnectionLease extends QueryExecutor {
  release(options?: { discard?: boolean }): void | Promise<void>;
}
```

`describe()`와 `describeBulk()`는 lease 획득 전 순수 materialization입니다.
Hint, shape, transport를 그곳에서 검증하고, 실패 시 execution flag를 모두
false로 유지합니다. Provider와 모든 lease는 정확히 같은 불변 binding adapter
객체를 노출해야 합니다. 불투명 driver request는 `WeakMap` 등으로 내부에
보관하세요.

Prepared logical shape는 result kind, dialect, canonical segments, 순서 있는
hint/direction/output metadata입니다. `$1`, `?`, `:1`, `@p1` 표기는 transport
세부 사항이지 shape identity가 아닙니다. 값은 바뀔 수 있으나 shape는 바뀔 수
없습니다.

## Executor와 cancellation

```ts
interface QueryExecutor {
  readonly statementBinding: StatementBindingAdapter;
  query<Row>(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Promise<QueryExecutionResult<Row>>;
  stream<Row>(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): AsyncIterable<Row>;
  call(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Promise<DriverRoutineResult>;
  bulk?(bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): Promise<BulkExecutionResult>;
  begin?(options?: TransactionOptions): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(name: string): Promise<void>;
  rollbackTo?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}
```

이미 abort된 signal은 자신의 `reason`으로 거부합니다. 활성 signal에는 실제
물리 cancellation 경로가 필요하며, 없으면 I/O 전에 `UnsupportedFeatureError`,
feature `statement.cancel`, `BRAID_CANCEL_UNSUPPORTED`로 거부합니다.
Iteration만 중단하는 것은 cancellation이 아닙니다. `stream`은 실제 driver
경로여야 하며 `call`은 lease 반환 전에 모든 cursor, result set, request,
carrier를 materialize하고 닫아야 합니다. Buffering으로 stream을 흉내 내거나
routine carrier를 추측하지 마세요.

## 완전한 text-positional 예시

```ts
import {
  UnsupportedFeatureError,
  createRenderedStatement,
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type ExecutionOptions,
  type QueryExecutionResult,
  type QueryExecutor,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
  type StatementBindingDescription,
} from "@sqlbraid/core";

interface WireClient {
  execute<Row>(text: string, values: readonly unknown[]): Promise<QueryExecutionResult<Row>>;
  release(options?: { discard?: boolean }): void | Promise<void>;
}

const requests = new WeakMap<StatementBindingDescription, { statement: RenderedStatement; text: string; values: readonly unknown[] }>();

function assertSignal(options?: ExecutionOptions): void {
  if (options?.signal?.aborted) throw options.signal.reason;
  if (options?.signal) throw new UnsupportedFeatureError("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "acme-wire는 활성 statement를 취소할 수 없습니다");
}

export const acmeBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    if (statement.parameters.some((parameter) => parameter.hint !== undefined)) {
      throw new UnsupportedFeatureError("parameter.hint", "BRAID_BIND_HINT_UNSUPPORTED", "acme-wire에는 hint API가 없습니다");
    }
    const binding = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    const text = binding.parameterizedSql;
    if (text === undefined) throw new TypeError("BRAID_BIND_TRANSPORT: parameterized SQL 없음");
    requests.set(binding, { statement, text, values: statement.parameters.map((parameter) => parameter.value) });
    return binding;
  },
});

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeBinding,
    async query<Row>(statement, binding, options) {
      assertSignal(options);
      statement = createRenderedStatement(statement);
      const description = binding ?? acmeBinding.describe(statement, { dialectId: statement.dialectId, requestedReuse: "auto" });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new TypeError("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.text, request.values);
    },
    stream(_statement, _binding, options): AsyncIterable<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError("statement.stream", "BRAID_STREAM_UNSUPPORTED", "acme-wire에는 stream protocol이 없습니다");
    },
    async call(_statement, _binding, options): Promise<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError("routine.call", "BRAID_CALL_UNSUPPORTED", "acme-wire에는 routine protocol이 없습니다");
    },
  };
}

export function createAcmeProvider(acquireClient: () => Promise<WireClient>): ConnectionProvider {
  return {
    statementBinding: acmeBinding,
    async acquire(): Promise<ConnectionLease> {
      const client = await acquireClient();
      const executor = createAcmeExecutor(client);
      let released = false;
      return { ...executor, async release(options) { if (released) return; released = true; await client.release(options); } };
    },
  };
}
```

## Capability와 evidence

Transaction isolation은 고정된 `read-uncommitted`, `read-committed`,
`repeatable-read`, `serializable` literal과 `readOnly`만 사용합니다. Malformed
runtime 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`, 유효하지만 지원하지
않는 option은 `BRAID_TX_OPTION_UNSUPPORTED`, 중첩 명시 option은
`BRAID_TX_OPTIONS_NESTED`입니다. Canonical capability key는
`statement.prepare`, `statement.stream`, `statement.bulk`, `transaction`,
`transaction.savepoint`, `routine.out`, `routine.result-sets`,
`routine.out-cursor`, `routine.return-value`입니다.

Bun SQL은 사용자가 선택하는 `dialect: "postgres" | "mysql" | "mariadb" |
"sqlite"`가 필요한 하나의 adapter family이며 auto-detect하지 않습니다.
Deno는 public driver API가 동작하면 기존 adapter를 재사용할 수 있습니다.
어느 쪽도 검증되지 않은 database/runtime/profile tuple을 승격하지 않습니다.
전체 checklist는 [repository driver-author guide](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md)를 참고하세요.
