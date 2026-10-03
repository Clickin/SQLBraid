---
title: 이식 가능한 에이전트 skill
description: 호환되는 코딩 에이전트에 SQLBraid 애플리케이션 개발 지침을 설치합니다.
---

SQLBraid는 [`skills/sqlbraid/`](https://github.com/Clickin/SQLBraid/tree/main/skills/sqlbraid)에 공식 Agent Skill을 제공합니다. 이 skill은 일반 SQL 지식만으로는 안전하게 추론할 수 없는 SQLBraid 규칙을 에이전트에게 알려줍니다.

- 결과 종류
- 값 보간과 구조적 보간
- 물리 연결의 범위
- 어댑터 capability
- 메타데이터 증거
- 코드 생성

표준 `skills` CLI로 설치하세요.

```sh
npx skills add Clickin/SQLBraid --skill sqlbraid
```

skill은 애플리케이션 개발용입니다. 기본 작업 흐름:

- 일반 SQL은 SQL로 유지합니다. ORM이나 query-builder DSL로 바꾸지 않습니다.
- `sql.rows`, `sql.command`, `sql.call`로 의도한 결과 종류를 유지합니다.
- 일반 보간은 값 바인딩으로 취급합니다. 식별자와 SQL 구조에는 명시적인 structural helper를 사용합니다.
- 트랜잭션과 세션의 pinning, 선택한 어댑터의 실제 capability를 유지합니다.
- 프로젝트의 의미 증거가 있으면 SQLBraid LSP나 JSON CLI inspection을 사용합니다.
- 메타데이터는 개방 세계의 긍정적 증거로 취급합니다. 완전한 카탈로그가 아닙니다.
- 설정이나 메타데이터를 바꾼 다음 모델을 다시 생성합니다. `sqlbraid codegen --check`를 실행합니다. 생성된 출력을 직접 수정하지 않습니다.

query, runtime, tooling의 세부 규칙은 `skills/sqlbraid/references/`에 있습니다. 호환 에이전트는 작업에 필요할 때만 이 규칙을 읽습니다.

SQLBraid에는 MCP가 필요하지 않습니다. LSP, CLI inspection, portable skill은 서로 독립적인 통합 경로입니다.

skill이 없는 에이전트를 위해 문서 사이트는 `llms.txt` 인덱스와 각 문서의 raw Markdown도 제공합니다. 문서 빌드마다 이 산출물이 생성됩니다. 따라서 `/latest`는 현재 문서를 따르고, `/v/<version>`은 해당 릴리스의 불변 snapshot에 고정됩니다.

드라이버와 executor 작성자는 사용자 지정 transport를 구현하기 전에 [드라이버 작성자 바인딩 가이드](/SQLBraid/agents/driver-author/)도 읽어야 합니다.
