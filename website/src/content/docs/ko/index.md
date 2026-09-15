---
title: SQLBraid
description: SQL을 작성하고 TypeScript를 유지하세요. 쿼리 빌더 변환 계층은 건너뜁니다.
template: splash
hero:
  title: SQL을 작성하고 TypeScript를 유지하세요.
  tagline: SQLBraid는 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server 및 브라우저 WASM, D1을 위한 안전한 바인딩, 읽기 쉬운 동적 SQL, 명시적 결과 계약, 소형 런타임을 제공합니다.
  actions:
    - text: 시작하기
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: GitHub에서 보기
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid는 SQL 우선 TypeScript 데이터 액세스 도구입니다. 쿼리 빌더 변환 계층 없이 익숙한 SQL을 그대로 사용하면서, 프로덕션에 중요한 경계를 유지합니다.

- **SQL이 그대로 보입니다.** 태그된 템플릿은 일반 SQL과 데이터베이스별 기능을 보존합니다.
- **값은 계속 바인드됩니다.** 일반 값 보간은 논리 값 parameter가 되고 선택된 드라이버가 placeholder/구체화 전송을 소유하며, 구조적 SQL에는 명시적 헬퍼가 필요합니다.
- **결과가 명시적입니다.** `rows`, `command`, `call`을 선언하면 런타임 검사가 불일치를 잡아냅니다.
- **런타임 의미가 정직합니다.** 직접 연결과 풀은 서로 다른 팩토리를 사용하며, 트랜잭션은 하나의 물리적 연결을 고정합니다.
- **도구는 선택 사항입니다.** 메타데이터, 결정적 코드 생성, LSP, CLI 검사, VS Code 지원은 런타임 의존성 경로에 들어오지 않습니다.

:::tip SQLite로 시작하기
외부 서버 없이 실행되는 [5분 SQLite 빠른 시작](/SQLBraid/getting-started/sqlite/)으로 시작하세요. 브라우저 및 Worker 환경은 [SQLite WASM과 D1](/SQLBraid/getting-started/sqlite-browser/)을 참고하세요. 서비스 데이터베이스가 필요하면 [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/), 또는 [MariaDB](/SQLBraid/getting-started/mariadb/)로 이동하세요.
:::

## SQLBraid가 아닌 것

SQLBraid는 임의의 SELECT 결과 타입을 추론하거나, 객체 그래프를 생성하거나, 모델 DSL 뒤에 SQL을 숨기지 않습니다. 작성한 SQL과 선언한 행 타입이 계약입니다. 행에 검증이나 변환이 필요할 때는 Standard Schema 매핑을 사용할 수 있습니다.

데이터베이스에서 애플리케이션으로 값이 이동하는 경계는 [데이터 표현과
숫자 정확도](/SQLBraid/concepts/data-representation/)를 참고하세요. 각
driver 프로필에는 런타임이 실제로 받을 수 있는 정수, 10진수, JSON,
temporal, binary 값이 기록되어 있습니다.

## 문서 출시 안내

이 문서는 0.1.0 프리릴리스 문서입니다. 현재 tree에는 session/lease 소유권,
고정 transaction option, prepared input factory, capability 기반
cancellation, 명시적인 unsupported 오류가 포함됩니다. 이 API 변경의 영향을
받은 target의 지원 label과 증거는 [런타임/드라이버 증거
매트릭스](/SQLBraid/reference/support/)가 기록한 정확한 database, driver,
profile, runtime, capability tuple과 revision별 실행 workflow에만 적용됩니다.
인접한 버전·runtime·profile·로컬 binding 또는 package 설치로 인증을
추론하지 마세요. 최종 exact-SHA Runtime, Docs, Release gate와 명시적인
release 승인은 별도 요구사항입니다. 통합을 선택하기 전에
[릴리스 노트와 제한 사항](/SQLBraid/release/notes/) 및
[런타임/드라이버 증거 매트릭스](/SQLBraid/reference/support/)를 확인하세요.
