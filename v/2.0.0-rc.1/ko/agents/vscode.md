# VS Code 확장

> SQLBraid의 얇은 TypeScript 클라이언트를 씁니다. 기본 TypeScript 지원은 그대로 켜져 있습니다.

`extensions/vscode` 패키지는 표준 SQLBraid 언어 서버를 쓰는 얇은 클라이언트입니다. VS Code `>=1.121.0`을 대상으로 합니다. 설정 파일이나 의존성으로 SQLBraid 프로젝트임이 확인될 때만 시작합니다. 기본 TypeScript 지원은 그대로 켜져 있습니다.

확장은 SQLBraid 설정 파일을 Node 코드로 실행합니다. 그래서 신뢰하지 않는 워크스페이스를 지원하지 않습니다. VS Code는 제한 모드(Restricted Mode)에서 확장을 비활성화하고, 워크스페이스를 신뢰한 뒤에 시작합니다.

확장이 추가하는 기능은 다음과 같습니다.

- SQLBraid 진단과 의미 기반 탐색
- **Generate Models**
- **Check Generated Models**
- **Reload Project**

확장 자체에는 분석 엔진이 없습니다. VSIX 안에는 확장이 고정한 정확한 버전의 서버·CLI 패키지가 들어 있고, 버전을 검사합니다. 전역 서버나 워크스페이스 서버를 몰래 고르지 않습니다.

깨끗한 프로필에서 다음 순서로 확인해 보세요.

1. 패키징된 VSIX를 설치합니다.
2. SQLBraid 태그를 import하는 프로젝트를 엽니다.
3. TypeScript/TSX 언어 지원이 여전히 기본 TypeScript 확장에서 오는지 확인합니다.
4. 프로젝트에 메타데이터·코드 생성 설정이 있으면 명령 팔레트에서 **Generate Models**를 실행하고, 이어서 **Check Generated Models**를 실행합니다.

언어 클라이언트는 워크스페이스 기준 상대 경로로 파일을 고릅니다. 그래서 워크스페이스 밖의 TypeScript 파일이 실수로 프로젝트 근거가 되지 않습니다.
