# SQLBraid

> 쿼리 빌더 없이 SQL을 순수 SQL로, 하지만 타입 안전하게.

SQLBraid는 TypeScript용 SQL 중심 데이터 접근 라이브러리입니다. 쿼리 빌더 DSL이나 ORM 모델로 번역할 필요 없이 태그드 템플릿 안에 순수 SQL을 그대로 작성합니다.

- **순수 SQL 유지:** 태그드 템플릿 안에 표준 SQL과 각 데이터베이스의 고유 기능을 그대로 작성합니다.
- **안전한 파라미터 바인딩:** 일반 `${value}` 보간은 항상 바인딩 파라미터로 분리되며, 드라이버 어댑터가 각 DB 규격(`$1`, `?`, `:1`, `@p1`)에 맞춰 플레이스홀더를 생성합니다. 동적 식별자나 조건 조각에는 명시적 헬퍼(`sql.ident`, `sql.list`, `sql.join`, `sql.fragment`)를 사용합니다.
- **명시적인 결과 선언:** `sql.rows<T>`, `sql.command`, `sql.call`로 반환 형태를 선언하거나 Standard Schema(Zod, Valibot, ArkType 등)를 연결해 런타임 검증과 변환을 수행합니다.
- **투명한 커넥션 관리:** 단일 연결과 커넥션 풀은 서로 다른 팩토리 함수를 사용하며, `db.tx`는 트랜잭션 동안 단일 물리 커넥션을 고정합니다.
- **선택적 도구 생태계:** 스키마 코드 생성, SQL 마이그레이션, 빌드 타임 지시어 컴파일러(Vite, Webpack/Next.js), LSP 및 VS Code 확장은 기본 런타임의 의존성이 아닌 선택적 패키지이며 외부 런타임 의존성을 추가하지 않습니다.

:::tip SQLite로 시작하기
[5분 SQLite 빠른 시작](/SQLBraid/latest/getting-started/sqlite.md)은 외부 서버 없이 실행됩니다. 브라우저와 Worker 환경은 [SQLite WASM과 D1](/SQLBraid/latest/getting-started/sqlite-browser.md)을 보세요. 서버형 데이터베이스가 필요하면 [PostgreSQL](/SQLBraid/latest/getting-started/postgres.md), [MySQL](/SQLBraid/latest/getting-started/mysql.md), [MariaDB](/SQLBraid/latest/getting-started/mariadb.md)로 넘어가세요.
:::

## SQLBraid가 하지 않는 일

SQLBraid는 ORM이 아닙니다. 연관 관계를 자동으로 로딩하거나 아이덴티티 맵을 두지 않으며, 임의의 `SELECT` 문에서 결과 타입을 추론하지도 않습니다. 반환 행 타입은 직접 선언하거나 Standard Schema로 검증하며, 테이블 모델(`Row`, `Insert`, `Update`)은 `@sqlbraid/codegen`으로 생성할 수 있습니다.

64비트 정수, 정밀 소수(`DECIMAL`), JSON, 날짜·시간 값이 드라이버별로 어떻게 전달되는지는 [데이터 표현과 값 정확도](/SQLBraid/latest/concepts/data-representation.md)를 참고하세요.

## 출시 문서

공개 API는 안정화되어 시맨틱 버저닝을 따릅니다(`sqlbraid` 2.x 및 `@sqlbraid/*` 1.x). 드라이버마다 지원하는 세부 기능이 다르므로, 사용하는 데이터베이스·드라이버·런타임 조합의 지원 범위는 [런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md), [릴리스 노트](/SQLBraid/latest/release/notes.md), [현재 제한 사항](/SQLBraid/latest/release/limitations.md)에서 확인하세요.
