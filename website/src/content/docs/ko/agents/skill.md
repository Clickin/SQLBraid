---
title: 이식 가능한 에이전트 스킬
description: 호환되는 코딩 에이전트에 SQLBraid 애플리케이션 개발 지침을 설치합니다.
---

SQLBraid는 공식 Agent Skill을 [`skills/sqlbraid/`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid)에서 제공합니다. 일반적인 SQL 지식만으로는 에이전트가 안전하게 추론할 수 없는 SQLBraid 규칙을 알려 줍니다.

- 결과 종류
- 값 보간과 구조 보간의 차이
- 물리 커넥션의 범위
- 어댑터별 기능
- 메타데이터 근거
- 코드 생성

표준 `skills` CLI로 설치하세요.

```sh
npx skills add Clickin/SQLBraid --skill sqlbraid
```

이 스킬은 애플리케이션 개발용입니다. 기본 작업 원칙은 다음과 같습니다.

- 일반 SQL은 SQL로 둡니다. ORM이나 쿼리 빌더 DSL로 옮기지 않습니다.
- `sql.rows`, `sql.command`, `sql.call`로 의도한 결과 종류를 드러냅니다.
- 일반 보간은 값 바인딩으로 다룹니다. 식별자와 SQL 구조에는 명시적인 구조 헬퍼를 씁니다.
- 트랜잭션·세션의 커넥션 고정과, 선택한 어댑터가 실제로 지원하는 기능을 지킵니다.
- 프로젝트의 분석 근거를 쓸 수 있으면 SQLBraid LSP나 CLI의 JSON 검사를 씁니다.
- 메타데이터는 완전한 카탈로그가 아니라 열린 세계의 긍정적 근거로 다룹니다.
- 설정이나 메타데이터를 고친 뒤 모델을 다시 생성하고 `sqlbraid codegen --check`를 실행합니다. 생성된 출력을 직접 고치지 않습니다.

쿼리, 런타임, 도구에 대한 자세한 규칙은 `skills/sqlbraid/references/`에 있습니다. 호환 에이전트는 작업에 필요할 때만 이 파일을 읽습니다.

SQLBraid에는 MCP가 필요 없습니다. LSP, CLI 검사, 에이전트 스킬은 서로 독립된 연동 방법입니다.

스킬이 없는 에이전트를 위해 문서 사이트는 `llms.txt` 인덱스와 각 문서의 원본 Markdown도 제공합니다. 이 파일들은 문서를 빌드할 때마다 생성됩니다. 그래서 `/latest`는 현재 문서를 따르고, `/v/<version>`은 해당 릴리스의 변하지 않는 스냅샷을 가리킵니다.

드라이버나 실행기를 직접 만든다면, 전송 방식을 구현하기 전에 [드라이버 작성자용 바인딩 가이드](/SQLBraid/agents/driver-author/)도 읽어야 합니다.
