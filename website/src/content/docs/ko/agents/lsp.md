---
title: 에이전트용 LSP
description: 표준 Language Server Protocol로 코딩 에이전트에 SQLBraid 근거를 제공합니다.
---

SQLBraid는 표준 stdio LSP 서버를 제공합니다. `vscode-languageserver`로 만들었지만 VS Code 전용 프로토콜이 아닙니다. 다음 명령으로 실행하세요.

```bash
sqlbraid-language-server --config ./sqlbraid.config.mjs
```

에이전트 실행 환경이 LSP를 지원하면 진단, 호버, 자동 완성, 정의로 이동, 참조 찾기, 문서·워크스페이스 심볼, 시그니처 도움말에 LSP를 먼저 쓰세요.

| LSP 기능       | SQLBraid가 제공하는 근거                            |
| -------------- | --------------------------------------------------- |
| Diagnostics    | Braid 오류와, 오버레이에서만 생기는 TypeScript 오류 |
| Completion     | 메타데이터 후보 (정적 SQL 안에서만)                 |
| Hover          | 쿼리 선언, 바인딩, 방언, 알려진 메타데이터 정보     |
| Definition     | 현재 생성된 선언·속성, 또는 메타데이터 JSON 위치    |
| References     | 어휘상 확실한 식별자만. 모호한 CTE·별칭은 제외      |
| Symbols        | 쿼리 단위, 필터링된 메타데이터·생성 선언            |
| Signature help | 루틴 (`argumentsComplete: true`인 경우에만)         |

메타데이터는 "열린 세계"를 전제로 한 긍정적 근거입니다. 서버는 메타데이터에 없는 테이블, 열, 루틴, 타입, 확장, 임시 객체, 런타임 UDF, CTE를 잘못되었다고 판단하지 않습니다. 어휘 문맥이 불확실하면 정보를 덜 줄 뿐, SQL 오류를 내지 않습니다. 서버는 임의의 SQL 구문 트리를 재구성하지 않고, 임의의 SELECT 문에서 결과 타입을 추론하지도 않습니다.

생성된 코드로 이동할 때는 현재 소스를 확인합니다. 오래되었거나 없는 출력에 위치를 지어내지 않습니다. 출력이 최신인지는 `sqlbraid codegen --check`가 판단합니다.

- 워크스페이스는 현재 tsconfig에 포함된 소스 파일을 모두 인덱싱합니다.
- 참조 찾기는 필요한 후보만 불러옵니다. 저장하지 않은 열린 문서를 먼저 쓰고, 파일 사이마다 취소 여부를 확인합니다.
- 분석 결과와 디스크 소스 캐시의 크기는 제한됩니다.
- 일반 호버와 자동 완성은 프로젝트 전체를 읽지 않습니다.

에이전트 연동에 MCP는 필요 없습니다. LSP가 기본 표준 인터페이스입니다. 실행 환경이 LSP를 쓸 수 없으면 CLI의 JSON 검사를 쓰세요.
