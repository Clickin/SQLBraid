---
title: SQLBraid
description: SQL을 작성하고 TypeScript를 유지하세요. 쿼리 빌더 변환 계층은 건너뜁니다.
template: splash
hero:
  title: SQL을 작성하고 TypeScript를 유지하세요.
  tagline: SQLBraid는 PostgreSQL, MySQL, SQLite, Oracle, SQL Server를 위한 안전한 바인드, 읽기 쉬운 동적 SQL, 명시적 결과 계약, 소형 런타임을 제공합니다.
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
외부 서버 없이 실행되는 [5분 SQLite 빠른 시작](/SQLBraid/getting-started/sqlite/)으로 시작하세요. 서비스 데이터베이스가 필요해지면 [PostgreSQL](/SQLBraid/getting-started/postgres/) 또는 [MySQL](/SQLBraid/getting-started/mysql/)로 이동하세요.
:::

## SQLBraid가 아닌 것

SQLBraid는 임의의 SELECT 결과 타입을 추론하거나, 객체 그래프를 생성하거나, 모델 DSL 뒤에 SQL을 숨기지 않습니다. 작성한 SQL과 선언한 행 타입이 계약입니다. 행에 검증이나 변환이 필요할 때는 Standard Schema 매핑을 사용할 수 있습니다.

데이터베이스에서 애플리케이션으로 값이 이동하는 경계는 [데이터 표현과
숫자 정확도](/SQLBraid/concepts/data-representation/)를 참고하세요. 각
driver 프로필에는 런타임이 실제로 받을 수 있는 정수, 10진수, JSON,
temporal, binary 값이 기록되어 있습니다.

## 문서 출시 안내

이 문서는 0.1.0 프리릴리스 문서입니다. PV18 profile-coherent 값 정확도와
container 작업은 `2119d9676b05fb2531eaf7aac1ef37741600ba40`에서 시작합니다.
Stage A 구현 증거는 `53db135bd156b6d65dc91785a671dec5249c95d4` revision에
기록되었고 Runtime, Docs, Release 세 gate를 모두 통과했습니다. 여덟 개
정확한 프로필은 Stage A에서 Official이며 D1은 Compatible입니다.
[revision별 증거](/SQLBraid/reference/support/#릴리스-증거-출처)를
확인하세요. 이후 revision에는 별도 Stage B exact-final SHA 검증이 필요하며 Stage B 완료나
npm 발행은 주장하지 않습니다. 통합을 선택하기 전에
[릴리스 노트와 제한
사항](/SQLBraid/release/notes/) 및 [런타임/드라이버 증거
매트릭스](/SQLBraid/reference/support/)를 확인하세요.
