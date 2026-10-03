---
title: 에이전트용 LSP
description: 표준 Language Server Protocol로 코딩 에이전트에서 SQLBraid 증거를 얻습니다.
---

SQLBraid는 표준 stdio LSP 서버를 제공합니다. 이 서버는 `vscode-languageserver`를 사용합니다. VS Code 전용 프로토콜이 아닙니다. 다음 명령으로 시작하세요.

```bash
sqlbraid-language-server --config ./sqlbraid.config.mjs
```

에이전트 하네스가 LSP를 지원하면 진단, hover, completion, definition, references, 문서/워크스페이스 symbols, signature help에 LSP를 먼저 사용하세요.

| LSP 작업       | SQLBraid 증거                                        |
| -------------- | ---------------------------------------------------- |
| Diagnostics    | Braid 오류와 overlay에만 있는 매핑된 TypeScript 오류 |
| Completion     | 메타데이터 후보 (정적 SQL에서만)                     |
| Hover          | 쿼리 선언, 바인드, dialect, 알려진 메타데이터 사실   |
| Definition     | 현재 생성된 선언/속성 또는 메타데이터 JSON 위치      |
| References     | 긍정적 어휘 식별자; 모호한 CTE/alias 출현은 제외     |
| Symbols        | 쿼리 단위와 필터링된 메타데이터/생성 선언            |
| Signature help | 루틴 (`argumentsComplete: true`인 경우에만)          |

메타데이터는 개방 세계의 긍정적 증거입니다. 서버는 누락된 테이블, 열, 루틴, 타입, 확장, 임시 객체, 런타임 UDF, CTE를 유효하지 않다고 선언하지 않습니다. 어휘 컨텍스트가 불확실하면 서버는 정보를 덜 제공합니다. SQL 오류를 내지 않습니다. 서버는 임의 SQL AST를 재구성하지 않습니다. 임의 SELECT 문의 결과 타입을 추론하지 않습니다.

생성 코드로의 탐색은 현재 소스를 확인합니다. 오래되었거나 누락된 출력에 임의의 오프셋을 부여하지 않습니다. 출력이 최신인지는 `sqlbraid codegen --check`가 판단합니다.

- 워크스페이스는 현재 tsconfig 소스 파일을 모두 인덱싱합니다.
- References 요청은 필요할 때만 후보를 로드합니다. 열려 있는 저장되지 않은 문서를 먼저 사용합니다. 파일 사이에서 취소를 확인합니다.
- 파싱 분석 캐시와 디스크 소스 캐시는 크기가 제한됩니다.
- 일반 hover와 completion은 프로젝트 전체를 읽지 않습니다.

에이전트 통합에 MCP는 필요하지 않습니다. LSP가 기본 표준 인터페이스입니다. 하네스가 LSP를 사용할 수 없으면 CLI JSON 대체 수단을 사용하세요.
