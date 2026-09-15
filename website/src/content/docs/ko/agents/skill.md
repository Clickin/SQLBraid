---
title: 이식 가능한 에이전트 skill
description: 하네스가 달라도 코딩 에이전트에 동일한 SQLBraid 작업 흐름을 제공합니다.
---

저장소는 [`skills/sqlbraid/SKILL.md`](https://github.com/Clickin/SQLBraid/blob/main/skills/sqlbraid/SKILL.md)에 이식 가능한 skill을 제공합니다. 이 skill은 특정 에이전트 프로토콜이 아니라 증거 규율을 담습니다.

요약하면 다음과 같습니다.

- 먼저 `sqlbraid.config.mjs`, `.js`, `.cjs` 또는 패키지 의존성을 찾습니다.
- 하네스가 지원하면 표준 LSP를 사용합니다.
- 지원하지 않으면 `sqlbraid inspect ... --json`을 사용합니다.
- 메타데이터를 개방 세계의 긍정적 증거로 취급합니다. 없음은 잘못된 SQL의 증거가 아닙니다.
- dialect, 드라이버, 실행 런타임, 트랜잭션 프로필을 독립적인 축으로 유지합니다.
- 모델을 재생성하기 전에 설정이나 메타데이터를 변경하고 `sqlbraid codegen --check`를 실행합니다.

SQLBraid에는 MCP가 필요하지 않습니다. 에이전트는 일반 LSP 전송을 사용하거나 일회성 프로젝트 환경에서 CLI를 호출할 수 있습니다.

드라이버와 executor 작성자는 사용자 지정 전송을 구현하기 전에 [드라이버 작성자 바인딩 가이드](/SQLBraid/agents/driver-author/)를 읽으세요.
