---
title: SQLBraid
description: SQL을 작성하고 TypeScript를 유지하세요. 쿼리 빌더 변환 계층은 건너뜁니다.
template: splash
hero:
  title: SQL을 작성하고 TypeScript를 유지하세요.
  tagline: SQLBraid는 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server를 위한 안전한 바인딩, 읽기 쉬운 동적 SQL, 명시적 결과 선언, 작은 런타임을 제공합니다. 브라우저 WASM과 D1도 지원합니다.
  actions:
    - text: 시작하기
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: GitHub에서 보기
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid는 SQL 우선 TypeScript 데이터 액세스 툴킷입니다. 쿼리 빌더 변환 계층이 없습니다. 경계는 프로덕션에 맞게 설계되어 있습니다.

- **SQL이 그대로 보입니다.** 태그된 템플릿은 일반 SQL과 데이터베이스별 기능을 유지합니다.
- **값은 바인드됩니다.** 일반 값 보간은 논리 값 parameter가 됩니다. 선택한 드라이버가 placeholder와 구체화 전송을 소유합니다. 구조적 SQL에는 명시적 헬퍼가 필요합니다.
- **결과가 명시적입니다.** `rows`, `command`, `call`을 선언하세요. 런타임 검사가 불일치를 찾습니다.
- **런타임 의미가 정직합니다.** 직접 연결과 풀은 서로 다른 팩토리를 사용합니다. 트랜잭션은 물리적 연결 하나를 고정합니다.
- **도구는 선택 사항입니다.** 메타데이터, 결정적 코드 생성, LSP, CLI 검사, VS Code 지원은 런타임 의존성이 아닙니다.

:::tip SQLite로 시작하기
[5분 SQLite 빠른 시작](/SQLBraid/getting-started/sqlite/)은 외부 서버 없이 실행됩니다. 브라우저와 Worker는 [SQLite WASM과 D1](/SQLBraid/getting-started/sqlite-browser/)을 참고하세요. 서비스 데이터베이스가 필요하면 [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/), [MariaDB](/SQLBraid/getting-started/mariadb/)로 이동하세요.
:::

## SQLBraid가 하지 않는 일

SQLBraid는 임의 SELECT 문의 결과 타입을 추론하지 않습니다. 객체 그래프를 만들지 않습니다. 모델 DSL 뒤로 SQL을 숨기지 않습니다. 작성한 SQL과 선언한 행 타입이 결과를 정의합니다. 행에 검증이나 변환이 필요하면 Standard Schema 매핑을 사용하세요.

데이터베이스 값과 애플리케이션 값 사이의 경계는 [데이터 표현과
숫자 정확도](/SQLBraid/concepts/data-representation/)를 참고하세요. 각
driver 프로필은 런타임이 실제로 받을 수 있는 정수, 10진수, JSON,
temporal, binary 값을 기록합니다.

## 출시 문서

1.0.0 GA는 공개 API를 안정화합니다. 드라이버 기능은 드라이버마다 다릅니다. 따라서
데이터베이스, 드라이버, 런타임 조합의 정확한 기능은
[런타임/드라이버 지원 매트릭스](/SQLBraid/reference/support/)에서 확인하세요.

자세한 내용은 [릴리스 노트와 제한 사항](/SQLBraid/release/notes/)을 참고하세요.
