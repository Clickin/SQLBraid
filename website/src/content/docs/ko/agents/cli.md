---
title: CLI inspect 대체 수단
description: 에이전트 하네스에 LSP 클라이언트가 없을 때 제한된 JSON 검사를 사용합니다.
---

CLI와 LSP 서버는 같은 도구 의미를 공유합니다. CLI 명령의 위치는 1부터 시작합니다.

다음 명령을 실행하는 프로젝트에 선택적 CLI를 설치하세요.

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

저장소 검색이 모호하면 `--config ./sqlbraid.config.mjs`를 사용하세요. JSON 출력은 초점이 좁고 크기가 제한됩니다. 해결되지 않은 쿼리 증거는 `resolved: false` 값을 가집니다. 이것은 SQL이 잘못되었다는 주장이 아닙니다.

일반적인 작업 흐름:

1. 프로젝트 설정과 메타데이터 증거를 찾습니다.
2. LSP 요청을 사용할 수 있으면 먼저 사용합니다.
3. 사용할 수 없으면 위 JSON 검사 명령 중 하나를 사용합니다.
4. 메타데이터나 설정이 바뀌면 `sqlbraid codegen`을 실행합니다. 그 다음 `sqlbraid codegen --check`를 실행합니다.
5. 생성 파일은 파생 파일로 취급합니다. 직접 수정하지 마세요.

`sqlbraid check`는 일반 TypeScript 진단을 추가할 수 있습니다. inspect 작업은 SQLBraid 증거만 제공합니다.
