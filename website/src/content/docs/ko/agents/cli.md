---
title: CLI 검사 명령
description: 에이전트 실행 환경에 LSP 클라이언트가 없을 때, 범위가 제한된 JSON 검사를 사용합니다.
---

CLI와 LSP 서버는 같은 분석 기능을 공유합니다. CLI 명령에서 위치는 1부터 셉니다.

다음 명령을 실행할 프로젝트에 선택 사항인 CLI를 설치하세요.

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

설정 파일을 찾는 데 모호함이 있으면 `--config ./sqlbraid.config.mjs`를 붙이세요. JSON 출력은 필요한 내용만 담고 크기가 제한됩니다. 쿼리에 대한 근거를 찾지 못하면 `resolved: false`가 나옵니다. SQL이 잘못되었다는 뜻은 아닙니다.

일반적인 작업 순서는 다음과 같습니다.

1. 프로젝트 설정과 메타데이터 근거를 찾습니다.
2. LSP 요청을 쓸 수 있으면 먼저 씁니다.
3. 쓸 수 없으면 위의 JSON 검사 명령 중 하나를 씁니다.
4. 메타데이터나 설정이 바뀌면 `sqlbraid codegen`을 실행하고, 이어서 `sqlbraid codegen --check`를 실행합니다.
5. 생성된 파일은 파생 결과물로 다룹니다. 직접 고치지 마세요.

`sqlbraid check`는 일반 TypeScript 진단도 함께 보여 줄 수 있습니다. inspect 명령은 SQLBraid 근거만 보여 줍니다.
