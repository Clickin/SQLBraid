---
title: VS Code 확장
description: 기본 TypeScript 지원을 대체하지 않고 SQLBraid의 얇은 TypeScript 클라이언트를 사용합니다.
---

`extensions/vscode` 패키지는 표준 SQLBraid language server를 위한 얇은 클라이언트입니다. VS Code `>=1.121.0`을 대상으로 하며, 설정/의존성으로 SQLBraid 프로젝트임이 확인될 때만 시작하고 기본 TypeScript 지원은 계속 활성화합니다.

확장은 다음 기능을 제공합니다.

- SQLBraid 진단 및 의미 기반 탐색
- **Generate Models**
- **Check Generated Models**
- **Reload Project**

확장에 의미 엔진은 없습니다. VSIX에는 버전 검사가 포함된 일치하는
`1.0.0-rc.1` server/CLI 의존성이 들어 있으며 전역 또는 워크스페이스 서버를
조용히 선택하지 않습니다.

깨끗한 테스트 프로필을 사용하려면 패키지된 VSIX를 설치하고 SQLBraid 태그 중 하나를 import하는 프로젝트를 연 다음 TypeScript/TSX 언어 지원이 계속 기본 제공 TypeScript 확장에서 오는지 확인하세요. 프로젝트에 메타데이터/codegen 설정이 있으면 명령 팔레트에서 Generate Models를 실행한 후 Check Generated Models를 실행하세요.

언어 클라이언트는 워크스페이스 기준 파일 selector를 사용하므로 워크스페이스 외부의 TypeScript 파일이 실수로 프로젝트 증거로 취급되지 않습니다.
