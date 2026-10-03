---
title: VS Code 확장
description: SQLBraid의 얇은 TypeScript 클라이언트를 사용합니다. 기본 TypeScript 지원은 계속 활성화됩니다.
---

`extensions/vscode` 패키지는 표준 SQLBraid 언어 서버의 얇은 클라이언트입니다. 대상은 VS Code `>=1.121.0`입니다. config나 의존성으로 SQLBraid 프로젝트임이 확인된 경우에만 시작합니다. 기본 TypeScript 지원은 계속 활성화됩니다.

확장이 추가하는 기능:

- SQLBraid 진단과 의미 탐색
- **Generate Models**
- **Check Generated Models**
- **Reload Project**

확장 안에는 의미 엔진이 없습니다. VSIX에는 확장이 고정한 정확한 버전의 서버/CLI 패키지가 버전 검사와 함께 들어 있습니다. 전역 서버나 워크스페이스 서버를 몰래 선택하지 않습니다.

깨끗한 프로필에서 다음 순서로 테스트하세요.

1. 패키징된 VSIX를 설치합니다.
2. SQLBraid 태그 중 하나를 import하는 프로젝트를 엽니다.
3. TypeScript/TSX 언어 지원이 여전히 기본 TypeScript 확장에서 오는지 확인합니다.
4. 프로젝트에 metadata/codegen config가 있으면 명령 팔레트에서 **Generate Models**를 실행합니다. 그 다음 **Check Generated Models**를 실행합니다.

언어 클라이언트는 워크스페이스 기준 상대 파일 selector를 사용합니다. 따라서 워크스페이스 밖의 TypeScript 파일이 실수로 프로젝트 증거가 되지 않습니다.
