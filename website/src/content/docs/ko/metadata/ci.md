---
title: CI에서 codegen --check
description: 생성 모델을 최신 상태로 유지합니다. 파생 파일을 직접 수정하지 마세요.
---

생성 모델은 파생 아티팩트입니다. 메타데이터 스냅샷이나 설정을 변경하세요. codegen을 실행하세요. 그 다음 CI가 출력이 최신인지 판단하게 하세요.

다음 명령을 실행하기 전에 선택적 CLI를 설치하세요.

```bash
npm install --save-dev @sqlbraid/cli
```

```bash
sqlbraid codegen
sqlbraid codegen --check
```

오래되었거나 누락된 출력은 CI 실패입니다. 메타데이터/설정을 바꾼 뒤, 그리고 패키징 전에 검사를 실행하세요. 빌드 시스템에 기계가 읽을 수 있는 대상 상태가 필요하면 `--json`을 사용하세요.

CLI는 출력을 쓰기 전에 선택한 모든 대상을 검증합니다. 따라서 유효한 대상 하나가 다른 대상의 잘못된 스냅샷이나 type policy를 가릴 수 없습니다. CLI는 최종 Row/Insert/Update 이름의 충돌도 전역으로 확인합니다. Windows에서 출력 충돌 키는 대소문자를 구분하지 않습니다.

생성 선언을 직접 수정하지 마세요. 모델이 잘못되었다면 inspector 증거, 선택한 TypePolicy, 필터, naming, override를 고치세요. 그 다음 다시 생성하세요. codegen은 임의 `SELECT`/`JOIN` 결과를 추론하지 않습니다. 그런 행 타입은 쿼리를 작성하는 곳에서 선언하세요.

CI는 runtime과 같은 representation profile을 선택해야 합니다. JSON/temporal
또는 numeric option을 바꾸면 다른 profile입니다. 그 profile에는 자체
TypePolicy provenance와 증거가 필요합니다. freshness check 통과만으로 그
불일치를 인증하지 않습니다.
