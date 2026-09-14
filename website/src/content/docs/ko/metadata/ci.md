---
title: CI에서 codegen --check
description: 파생 파일을 직접 수정하지 않고 생성 모델을 최신 상태로 유지합니다.
---

생성 모델은 파생 아티팩트입니다. 메타데이터 스냅샷이나 설정을 변경하고 codegen을 실행한 다음 CI를 최신 상태의 기준으로 삼으세요.

```bash
sqlbraid codegen
sqlbraid codegen --check
```

오래되었거나 누락된 출력은 CI 실패입니다. 메타데이터/설정을 바꾼 뒤와 패키징 전에 검사를 실행하세요. 빌드 시스템에 기계 판독 가능한 대상 상태가 필요하면 `--json`을 사용합니다.

CLI는 출력물을 쓰기 전에 선택한 모든 대상을 검증합니다. 따라서 한 대상이 유효하다는 이유로 다른 대상의 잘못된 스냅샷이나 type policy를 가릴 수 없습니다. 또한 최종 Row/Insert/Update 이름 충돌을 전역으로 확인하며, Windows 출력 충돌 키는 대소문자를 접습니다.

생성 선언을 직접 수정하지 마세요. 모델이 잘못되었다면 inspector 증거, 선택한 TypePolicy, 필터, naming 또는 override를 수정한 뒤 재생성하세요. 임의 `SELECT`/`JOIN` 추론은 codegen 범위 밖이므로 쿼리 위치에서 행 타입을 선언하세요.

CI는 runtime에서 사용하는 것과 같은 representation profile을 선택해야
합니다. JSON/temporal 또는 numeric option을 바꾸면 별도 profile이므로 자체
TypePolicy provenance와 증거가 필요합니다. freshness check가 통과해도
profile mismatch를 인증하지 않습니다.
