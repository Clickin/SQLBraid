# SQLBraid

> SQL은 직접 쓰고, TypeScript 타입은 그대로 지킵니다. 쿼리 빌더로 옮겨 적는 과정이 필요 없습니다.

SQLBraid는 TypeScript용 SQL 중심 데이터 접근 도구입니다. SQL을 쿼리 빌더 코드로 옮겨 적을 필요가 없습니다. 운영 환경에서 필요한 경계는 분명하게 지킵니다.

- **SQL이 그대로 보입니다.** 태그 템플릿 안에 일반 SQL과 데이터베이스별 기능을 그대로 씁니다.
- **값은 항상 바인딩됩니다.** 일반 보간은 논리적인 값 파라미터가 됩니다. 플레이스홀더와 실제 전송 방식은 선택한 드라이버가 정합니다. SQL 구조를 넣을 때는 명시적인 헬퍼가 필요합니다.
- **결과 종류를 명시합니다.** `rows`, `command`, `call` 중 하나를 선언하면 런타임 검사가 불일치를 찾아냅니다.
- **런타임 동작을 감추지 않습니다.** 직접 연결과 풀은 서로 다른 팩토리를 씁니다. 트랜잭션은 물리 커넥션 하나를 고정합니다.
- **도구는 선택 사항입니다.** 메타데이터, 결정적 코드 생성, LSP, CLI 검사, VS Code 지원은 런타임 의존성에 들어가지 않습니다.

:::tip SQLite로 시작하기
[5분 SQLite 빠른 시작](/SQLBraid/latest/getting-started/sqlite.md)은 외부 서버 없이 실행됩니다. 브라우저와 Worker 환경은 [SQLite WASM과 D1](/SQLBraid/latest/getting-started/sqlite-browser.md)을 보세요. 서버형 데이터베이스가 필요하면 [PostgreSQL](/SQLBraid/latest/getting-started/postgres.md), [MySQL](/SQLBraid/latest/getting-started/mysql.md), [MariaDB](/SQLBraid/latest/getting-started/mariadb.md)로 넘어가세요.
:::

## SQLBraid가 하지 않는 일

SQLBraid는 임의의 SELECT 문에서 결과 타입을 추론하지 않습니다. 객체 그래프를 조립하지 않고, 모델 DSL 뒤로 SQL을 숨기지도 않습니다. 결과의 모양은 직접 쓴 SQL과 선언한 행 타입이 정합니다. 행을 검증하거나 변환해야 하면 Standard Schema 매핑을 쓰세요.

데이터베이스 값과 애플리케이션 값 사이의 경계는 [데이터 표현과 값 정확도](/SQLBraid/latest/concepts/data-representation.md)에서 설명합니다. 드라이버 프로필마다 런타임이 실제로 받는 정수, 소수, JSON, 날짜·시간, 바이너리 값이 정리되어 있습니다.

## 출시 문서

1.0.0 GA로 공개 API가 안정화되었습니다. 지원하는 기능은 드라이버마다 다릅니다. 사용하는 데이터베이스, 드라이버, 런타임 조합에서 정확히 어떤 기능을 쓸 수 있는지는 [런타임·드라이버 지원 매트릭스](/SQLBraid/latest/reference/support.md)에서 확인하세요.

자세한 내용은 [릴리스 노트와 제한 사항](/SQLBraid/latest/release/notes.md)을 보세요.
