---
title: SQLBraid
description: SQL을 작성하고 TypeScript를 유지하세요. 쿼리 빌더 변환 계층은 건너뜁니다.
template: splash
hero:
  title: SQL을 작성하고 TypeScript를 유지하세요.
  tagline: SQLBraid는 PostgreSQL, MySQL, MariaDB, SQLite, Oracle, SQL Server 및 브라우저 WASM, D1을 위한 안전한 바인딩, 읽기 쉬운 동적 SQL, 명시적 결과 명세, 소형 런타임을 제공합니다.
  actions:
    - text: 시작하기
      link: /SQLBraid/getting-started/sqlite/
      icon: right-arrow
    - text: GitHub에서 보기
      link: https://github.com/Clickin/SQLBraid
      variant: minimal
---

SQLBraid는 SQL 우선 TypeScript 데이터 액세스 툴킷입니다. 쿼리 빌더 변환 계층 없이 익숙한 SQL을 그대로 사용하며, 프로덕션에 필수적인 경계를 유지합니다.

- **SQL이 그대로 보입니다.** 태그된 템플릿은 일반 SQL과 데이터베이스별 기능을 보존합니다.
- **값은 계속 바인드됩니다.** 일반 값 보간은 논리 값 parameter가 되고 선택된 드라이버가 placeholder/구체화 전송을 소유하며, 구조적 SQL에는 명시적 헬퍼가 필요합니다.
- **결과가 명시적입니다.** `rows`, `command`, `call`을 선언하면 런타임 검사가 불일치를 잡아냅니다.
- **런타임 의미가 정직합니다.** 직접 연결과 풀은 서로 다른 팩토리를 사용하며, 트랜잭션은 하나의 물리적 연결을 고정합니다.
- **도구는 선택 사항입니다.** 메타데이터, 결정적 코드 생성, LSP, CLI 검사, VS Code 지원은 런타임 의존성 경로에 들어오지 않습니다.

:::tip SQLite로 시작하기
외부 서버 없이 실행되는 [5분 SQLite 빠른 시작](/SQLBraid/getting-started/sqlite/)으로 시작하세요. 브라우저 및 Worker 환경은 [SQLite WASM과 D1](/SQLBraid/getting-started/sqlite-browser/)을 참고하세요. 서비스 데이터베이스가 필요하면 [PostgreSQL](/SQLBraid/getting-started/postgres/), [MySQL](/SQLBraid/getting-started/mysql/), 또는 [MariaDB](/SQLBraid/getting-started/mariadb/)로 이동하세요.
:::

## 설계 원칙 및 제한 사항

SQLBraid는 SELECT 결과 타입을 자동으로 추론하거나 객체 그래프를 생성하지 않으며, 모델 DSL 뒤로 SQL을 숨기지 않습니다. 작성한 SQL과 선언한 행 타입이 곧 명세입니다.

데이터베이스에서 애플리케이션으로 값이 이동하는 경계는 [데이터 표현과
숫자 정확도](/SQLBraid/concepts/data-representation/)를 참고하세요. 각
driver 프로필에는 런타임이 실제로 받을 수 있는 정수, 10진수, JSON,
temporal, binary 값이 기록되어 있습니다.

## 문서 출시 안내

이 문서는 SQLBraid 1.0.0 GA 기준입니다. GA는 공개 명세(contract)의 안정화를 뜻하며 모든 드라이버의 모든 기능을 보장하지는 않습니다. 현재 버전에는 세션/리스 소유권, 고정 트랜잭션 옵션, Prepared 입력 팩토리, 기능 기반 취소, 명시적 미지원 오류가 포함됩니다. 이 API 변경의 영향은 [런타임/드라이버 증거 매트릭스](/SQLBraid/reference/support/)에 기록된 데이터베이스, 드라이버, 프로필, 런타임, 기능 튜플 및 리비전별 실행 워크플로우에만 적용됩니다.
설치 버전이나 런타임 환경만으로 지원 여부를 추론하지 마세요. 최종 exact-SHA 런타임, 문서, 릴리스 게이트와 명시적인 릴리스 승인이 필요합니다. 통합 전 [릴리스 노트와 제한 사항](/SQLBraid/release/notes/) 및 [런타임/드라이버 증거 매트릭스](/SQLBraid/reference/support/)를 확인하세요.
