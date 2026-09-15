---
title: CLI inspect 대체 수단
description: 에이전트 하네스에 LSP 클라이언트가 없을 때 제한된 JSON 검사를 사용합니다.
---

CLI는 LSP 서버에서 사용하는 도구 의미를 공유합니다. CLI 명령의 위치는 1부터 시작합니다.

다음 명령을 실행하는 프로젝트에 선택적 CLI를 설치하세요.

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

저장소 검색이 모호할 때는 `--config ./sqlbraid.config.mjs`를 사용하세요. JSON은 초점을 좁히고 크기를 제한합니다. 해결되지 않은 쿼리 증거는 `resolved: false`로 보고되며, 이는 잘못된 SQL이라는 주장이 아닙니다.

일반적인 작업 흐름은 다음과 같습니다.

1. 프로젝트 설정과 메타데이터 증거를 찾습니다.
2. 가능하면 LSP 요청을 우선합니다.
3. 불가능하면 위 JSON 검사 명령 중 하나로 대체합니다.
4. 메타데이터나 설정이 바뀌면 `sqlbraid codegen`을 실행한 다음 `sqlbraid codegen --check`를 실행합니다.
5. 생성 파일은 파생물로 취급하며 직접 수정하지 않습니다.

`sqlbraid check`는 일반 TypeScript 진단을 추가할 수 있지만, inspect 작업은 SQLBraid 증거에 집중합니다.
