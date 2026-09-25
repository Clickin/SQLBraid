---
title: 에이전트용 LSP
description: 코딩 에이전트에서 SQLBraid 증거에 표준 언어 서버 프로토콜을 사용합니다.
---

SQLBraid는 `vscode-languageserver`로 구축한 표준 stdio LSP 서버를 제공합니다. 이는 VS Code 전용 프로토콜이 아닙니다. 다음 명령으로 시작하세요.

```bash
sqlbraid-language-server --config ./sqlbraid.config.mjs
```

에이전트 하네스가 LSP를 지원한다면 진단, hover, completion, definition, references, 문서/워크스페이스 symbols, signature help에 LSP를 먼저 사용하세요.

| LSP 작업       | SQLBraid 증거                                      |
| -------------- | -------------------------------------------------- |
| Diagnostics    | Braid 오류와 매핑된 overlay 전용 TypeScript 오류   |
| Completion     | 정적 SQL의 메타데이터 후보                         |
| Hover          | 쿼리 명세, 바인드, dialect, 알려진 메타데이터 사실 |
| Definition     | 현재 생성된 선언/속성 또는 메타데이터 JSON 위치    |
| References     | 긍정적 어휘 식별자; 모호한 CTE/alias 출현은 제외   |
| Symbols        | 쿼리 단위와 필터링된 메타데이터/생성 선언          |
| Signature help | `argumentsComplete: true`인 경우에만 루틴          |

메타데이터는 개방 세계의 긍정적 증거입니다. 누락된 테이블, 열, 루틴, 타입, 확장, 임시 객체, 런타임 UDF, CTE는 유효하지 않다고 선언되지 않습니다. 불확실한 어휘 컨텍스트에서는 SQL 오류 대신 제공하는 지능이 줄어듭니다. 서버는 임의 SQL AST를 재구성하거나 임의 SELECT 결과 타입을 추론하지 않습니다.

생성된 탐색은 현재 소스를 확인합니다. 오래되었거나 누락된 출력에 임의의 오프셋을 부여하지 않으며, `sqlbraid codegen --check`가 계속 최신 상태의 기준입니다. 워크스페이스는 현재 tsconfig 소스 파일을 모두 인덱싱합니다. References 요청은 후보를 지연 로드하고, 열려 있지만 저장되지 않은 문서를 우선하며, 파싱 분석 및 디스크 소스 캐시의 크기를 제한한 채 파일 사이에서 취소를 확인합니다. 일반 hover/completion은 프로젝트 전체를 읽지 않습니다.

에이전트 통합에 MCP는 필요하지 않습니다. LSP가 기본 표준 인터페이스이며, 하네스가 LSP를 사용할 수 없을 때 CLI JSON 대체 수단을 사용하세요.
