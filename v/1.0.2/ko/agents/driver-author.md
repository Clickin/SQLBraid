# 드라이버 작성자용 바인딩 가이드

> 값만 넘기는 경계를 지키면서 SQLBraid 어댑터를 직접 구현합니다.

이 가이드는 직접 만드는 `QueryExecutor`, `ConnectionProvider`, 바인딩 어댑터를 다룹니다. 현재 API를 설명할 뿐이며, 지원 등급이나 배포 근거를 제공하지는 않습니다.

지원 등급은 [런타임·드라이버 지원 매트릭스](/SQLBraid/v/1.0.2/reference/support.md)를 보세요. 각 등급은 데이터베이스, 드라이버, 프로필, 런타임, 기능의 정확한 조합 하나에만 적용되며, 해당 리비전과 워크플로 근거가 함께 기록됩니다. 비슷한 버전이나 패키지 설치만으로는 인증이 되지 않습니다. 정확한 SHA에 대한 Runtime, Docs, Release 최종 게이트와 명시적인 릴리스 승인은 별도 요구 사항입니다.

물리 계층 SPI는 동기 결과를 받을 수 있습니다. 애플리케이션 API는 계속 비동기입니다.

```ts
type Awaitable<T> = T | PromiseLike<T>;
```

`QueryExecutor.query`, `call`, 선택 사항인 `bulk`, 트랜잭션 제어 메서드는 `Awaitable`을 반환할 수 있습니다. `ConnectionProvider.acquire()`는 계속 `Promise`를 반환하고, `stream()`은 계속 `AsyncIterable`입니다. 따라서 동기 네이티브 이터레이터는 얇은 async generator 어댑터로 감싸야 합니다. 이렇게 해야 정리 동작과 범위 동작이 유지됩니다.

## 논리 문장의 불변 조건

core/template 렌더링은 변경할 수 없는 `RenderedStatement` 하나를 반환합니다.

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly nativeTemplate?: TemplateStringsArray;
  readonly dialectId: string;
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly routineProcedure?: RoutineProcedure;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1`입니다. 각 파라미터는 값입니다. 직접 만드는 드라이버는 파라미터를 SQL, 식별자, 중첩 SQL, 네이티브 태그 템플릿 명령으로 해석하면 안 됩니다. SQL 구조는 사용자가 명시적인 헬퍼(`sql.ident`, `sql.fragment`, `sql.raw`, `sql.list`, `sql.join`)로 작성하며, 이미 `segments`에 들어 있습니다.

## 바인딩과 리스

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
  describeBulk?(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription;
}
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  validateTransactionOptions?(options: TransactionOptions): void;
  acquire(): Promise<ConnectionLease>;
}
interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}
```

`describe()`와 `describeBulk()`는 커넥션을 획득하기 전에 실행되는 순수한 변환 단계입니다.

- 힌트, 형태, 전송 방식은 여기서 검증합니다.
- 이 단계에서 실패하면 두 실행 플래그가 모두 false입니다.
- 프로바이더와 리스는 정확히 같은 불변 바인딩 어댑터 객체를 노출해야 합니다.
- 드라이버 전용 요청 객체는 외부에 드러내지 마세요. 예를 들어 `StatementBindingDescription`을 키로 하는 `WeakMap`에 보관합니다.

준비된 쿼리의 논리적 형태는 결과 종류, 방언, 정규화된 세그먼트, 그리고 순서가 있는 힌트·방향·출력 메타데이터로 정해집니다. `$1`, `?`, `:1`, `@p1`은 전송 세부 사항일 뿐 형태 식별에 포함되지 않습니다. 값은 바뀔 수 있지만 구조적 형태는 바뀔 수 없습니다.

## 실행기 메서드와 취소

```ts
interface QueryExecutor {
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  query<Row>(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<QueryExecutionResult<Row>>;
  stream<Row>(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): AsyncIterable<Row>;
  call(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<DriverRoutineResult>;
  bulk?(
    bulk: RenderedBulk,
    binding: BulkBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<BulkExecutionResult>;
  validateTransactionOptions?(options: TransactionOptions): void;
  begin?(options?: TransactionOptions): Awaitable<void>;
  commit?(): Awaitable<void>;
  rollback?(): Awaitable<void>;
  savepoint?(name: string): Awaitable<void>;
  rollbackTo?(name: string): Awaitable<void>;
  releaseSavepoint?(name: string): Awaitable<void>;
}
```

- 시그널이 이미 중단된 상태라면 그 `reason`으로 reject하세요.
- 활성 시그널을 받으려면 물리적인 취소 경로가 있어야 합니다. 경로가 없으면 I/O 전에 `UnsupportedFeatureError`(기능 `statement.cancel`, 코드 `BRAID_CANCEL_UNSUPPORTED`)로 reject하세요. 반복만 멈추는 것은 취소가 아닙니다.
- `stream`은 실제 드라이버 경로여야 합니다.
- `call`은 리스를 반환하기 전에 모든 커서, 결과 집합, 요청, 출력 전달 객체를 메모리로 읽고 닫아야 합니다.
- 스트리밍을 흉내 내려고 버퍼링하지 마세요. 루틴 출력 전달 방식을 추측하지 마세요.

## 텍스트·위치 기반 바인딩 전체 예제

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

const requests = new WeakMap<
  StatementBindingDescription,
  { statement: RenderedStatement; text: string; values: readonly unknown[] }
>();

function assertSignal(options?: ExecutionOptions): void {
  if (options?.signal?.aborted) throw options.signal.reason;
  if (options?.signal) {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "acme-wire cannot cancel an active statement",
    );
  }
}

export const acmeBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    if (statement.parameters.some((parameter) => parameter.hint !== undefined)) {
      throw new UnsupportedFeatureError("parameter.hint", "BRAID_BIND_HINT_UNSUPPORTED", "acme-wire has no hint API");
    }
    const binding = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    const text = binding.parameterizedSql;
    if (text === undefined) throw new TypeError("BRAID_BIND_TRANSPORT: missing parameterized SQL");
    requests.set(binding, { statement, text, values: statement.parameters.map((parameter) => parameter.value) });
    return binding;
  },
});

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeBinding,
    async query<Row>(
      statement: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertSignal(options);
      statement = createRenderedStatement(statement);
      const description =
        binding ?? acmeBinding.describe(statement, { dialectId: statement.dialectId, requestedReuse: "auto" });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new TypeError("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.text, request.values);
    },
    stream(_statement, _binding, options): AsyncIterable<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "acme-wire has no stream protocol",
      );
    },
    async call(_statement, _binding, options): Promise<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError("routine.call", "BRAID_CALL_UNSUPPORTED", "acme-wire has no routine protocol");
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

## 기능과 근거

트랜잭션 격리 수준은 정해진 리터럴과 `readOnly`만 쓰세요.

- 형식이 잘못된 런타임 값은 `TypeError` / `BRAID_TX_OPTIONS_INVALID`로 실패합니다.
- 올바르지만 지원하지 않는 옵션은 `BRAID_TX_OPTION_UNSUPPORTED`를 씁니다.
- 중첩 트랜잭션에 명시적 옵션을 주면 `BRAID_TX_OPTIONS_NESTED`를 씁니다.

정규 기능 키는 `statement.prepare`, `statement.stream`, `statement.bulk`, `transaction`, `transaction.savepoint`, `routine.out`, `routine.result-sets`, `routine.out-cursor`, `routine.return-value`입니다.

Bun SQL은 어댑터 계열 하나를 씁니다. 사용자는 `dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`를 직접 골라야 하며, 어댑터가 자동으로 감지하지 않습니다.

- Bun.SQL MySQL과 MariaDB는 명시적인 `readOnly` 값을 둘 다 I/O 전에 거부합니다(`BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`). 옵션을 생략하면 네이티브 세션 기본값이 유지됩니다.
- Bun 1.3.14에서는 읽기 전용 실패가 롤백 후에도 커넥션에 남을 수 있습니다. 그래서 이렇게 오염된 예약 커넥션은 폐기해야 합니다.
- Bun.SQL PostgreSQL의 접근 모드와 표현 방식 프로필 옵션은 바뀌지 않습니다.

Deno에서는 공개 드라이버 API가 동작하는 범위에서 기존 어댑터를 쓸 수 있습니다. 위의 어느 설명도 검증되지 않은 데이터베이스·런타임·프로필 조합의 등급을 올리지 않습니다. 전체 점검 목록은 [저장소의 드라이버 작성자 가이드](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md)를 보세요.

SQLite의 경우:

- `node:sqlite`와 `better-sqlite3`는 `Awaitable`을 통해 물리 결과를 동기로 반환할 수 있습니다. 공개 데이터베이스 API는 그래도 비동기입니다. better-sqlite3는 여전히 이벤트 루프를 막습니다.
- INTEGER를 정확히 읽으려면 각 문장에 `safeIntegers(true)`를 쓰세요. 네이티브 반복은 그대로 노출합니다.
- libSQL 어댑터는 `intMode: "string"`을 명시해야 합니다. 대화형 트랜잭션 핸들을 쓰며, 일반 세션 고정은 지원한다고 주장하지 않습니다. 선택한 클라이언트에 점진적 커서가 없으면 스트리밍을 거부해야 합니다.
- 로컬 libSQL 근거로 원격 전송 방식이 인증되지는 않습니다.
