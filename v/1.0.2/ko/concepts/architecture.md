# 아키텍처 멘탈 모델

> 구현을 읽기 전에 SQLBraid의 실행 계층, 리소스 소유권, 기여자 책임 경계를 이해합니다.

import ArchitectureFlow from "../../../../components/ArchitectureFlow.astro";

SQLBraid는 경계가 좁은 파이프라인입니다. 일부러 이렇게 설계했습니다.

- SQL 텍스트는 그대로 보입니다.
- 값은 끝까지 값으로 남습니다.
- 물리적인 전송은 어댑터가 맡습니다.
- 커넥션과 범위가 올바른지는 런타임이 책임집니다.

<ArchitectureFlow locale="ko" />

## 네 개의 실행 계층

1. **`@sqlbraid/core`**는 인터페이스를 정의합니다. 논리 문장, 바인딩 SPI, 실행기·프로바이더 SPI, 런타임 API, 표현 방식 정책, 옵저버, 기능, 루틴, 공개 오류가 여기에 있습니다.
2. **`@sqlbraid/template`**은 태그 템플릿을 변경할 수 없는 `Query` 값으로 바꿉니다. 명시적인 SQL 구조를 전송 방식과 무관한 `RenderedStatement` 객체로 렌더링합니다.
3. **`@sqlbraid/runtime`**은 리스, 고정된 범위, 트랜잭션·세이브포인트의 연속성, 스트림 수명, 취소 경계, 결과 종류 검사, 애플리케이션 매핑을 맡습니다.
4. **드라이버 어댑터**는 논리 문장과 바인딩 설명을 네이티브 드라이버 호출로 바꿉니다. 네이티브 결과는 다시 SQLBraid 타입으로 정규화합니다.

### 꼭 기억할 불변 조건

```text
segments.length
===
parameters.length + 1
```

일반 `${value}` 보간은 바인딩 값입니다. SQL 구조가 되지 않습니다. SQL 구조를 넣으려면 `sql.ident`, `sql.fragment`, `sql.list`, `sql.join` 같은 명시적인 헬퍼가 필요합니다. `sql.raw`는 의도적으로 마련한 탈출구입니다.

플레이스홀더 문법은 바인딩·어댑터 경계에서만 나타납니다. PostgreSQL은 `$1`, MySQL은 `?`, Oracle은 `:1`, SQL Server는 `@p1`을 쓸 수 있습니다. 네이티브 템플릿 방식의 전송은 물리적으로 다른 표현을 쓸 수 있습니다.

## 런타임의 핵심 역할은 리소스 소유권입니다

풀을 쓰는 일반 조회는 다음 순서로 실행됩니다.

1. 리스를 획득합니다.
2. 물리 I/O를 실행합니다.
3. 리스를 반환합니다.
4. 그다음에야 비동기 Standard Schema 매핑을 실행합니다.

스트림은 다릅니다. 커서나 결과 집합은 이터레이터 정리가 끝날 때까지 리소스를 붙잡고 있습니다.

`db.session()`은 리소스 하나를 고정할 뿐 트랜잭션을 시작하지 않습니다. `db.tx()`는 고정된 리소스에서 물리 트랜잭션 하나를 시작합니다. 중첩 트랜잭션은 같은 리소스 위의 세이브포인트이며, 독립된 트랜잭션이 아닙니다.

루트나 상위 핸들을 쓰면 다른 커넥션으로 빠져나갈 수 있는 경우, SQLBraid는 그 호출을 거부합니다. 몰래 다른 커넥션으로 보내지 않습니다. 트랜잭션 제어나 정리 후 커넥션 상태가 불확실하면, 낙관적으로 재사용하지 않고 리소스를 사용 불가로 표시하거나 폐기합니다.

## prepare, batch, bulk는 규칙이 서로 다릅니다

- `db.prepare()`는 **SQLBraid의 논리적 형태**를 고정합니다. 모든 환경에서 서버 측 준비된 문장 캐시를 쓴다고 약속하지는 않습니다.
- `db.batch()`는 물리 커넥션 하나(또는 리스 하나)에서 여러 작업을 실행합니다. 작업 종류는 서로 달라도 됩니다. 배치는 **트랜잭션이 아닙니다**.
- `db.bulk()`는 같은 형태의 명령 하나를 여러 입력에 적용합니다. 물리적인 벌크 실행 방식은 어댑터가 고릅니다.

## TypePolicy는 애플리케이션 매핑이 아닙니다

`TypePolicy`는 데이터베이스와 네이티브 드라이버의 값을 SQLBraid의 정규 JavaScript 표현으로 정규화합니다. Standard Schema는 이 정규 표현을 애플리케이션·도메인 값으로 매핑합니다. 두 경계는 분리되어 있습니다. 그래서 런타임에 범용 코덱 프레임워크가 필요 없습니다.

## 도구는 별도 계층입니다

런타임 패키지는 메타데이터, 코드 생성, 컴파일러, CLI, 에디터, Vite 패키지에 의존하지 않습니다.

- `@sqlbraid/compiler`는 소스 탐색과 변환을 맡습니다.
- `@sqlbraid/metadata`는 데이터베이스 근거를 기록합니다.
- `@sqlbraid/codegen`은 메타데이터와 TypePolicy로 모델을 생성합니다.
- `@sqlbraid/tooling`은 LSP, CLI, 에디터 기능을 위해 긍정적 근거를 모읍니다.

메타데이터에 정보가 없다는 것은 근거를 찾지 못했다는 뜻입니다. 사용자의 SQL이 잘못되었다는 증거가 아닙니다.

## 소스를 읽는 순서

1. `packages/core/src/`: `statement.ts`(`RenderedStatement`), `query.ts`(`Query`), `binding.ts`(`StatementBindingAdapter`), `executor.ts`(`QueryExecutor`, `ConnectionProvider`), `database.ts`(`Database`), `authoring.ts`(`SqlTag`). `index.ts`는 재export만 합니다.
2. `packages/template/src/`: `tag.ts`(`createSqlTag()`)와 `render.ts`(렌더링 경로).
3. `packages/runtime/src/index.ts`: `createScopedDatabase()` → `prepareObserved()` → `prepare()`. 이어서 `operations/materialized.ts`: `runPrepared()` → `leaseForUse()` → `physical()` → `finalizePhysical()` → `processRows()`.
4. 런타임의 `stream()`, 그다음 `session()`과 `tx()`.
5. 참고용 어댑터로 PostgreSQL의 `pgStatementBinding` / `createPgExecutor()`. 그다음 리소스가 많은 어댑터인 Oracle.
6. 정적 도구를 다룬다면 compiler → metadata → codegen → tooling 순서로 읽습니다.

전체 설명과 기여자용 불변 조건은 저장소의 [한국어 멘탈 모델](https://github.com/Clickin/SQLBraid/blob/main/docs/mental-model.ko.md)을 보세요. 드라이버를 구현한다면 [드라이버 작성자용 가이드](/SQLBraid/v/1.0.2/agents/driver-author.md)도 읽어야 합니다.
