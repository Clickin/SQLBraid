# 브라우저 인터랙티브 미리보기

> 브라우저에서 일회용 SQLite WASM 데이터베이스에 실제 SQL을 편집하고 실행합니다.

아래 미리보기는 애플리케이션 번들에서 사용할 수 있는 SQLBraid SQLite WASM
어댑터와 같은 경로를 사용합니다. SQL을 직접 작성하거나 붙여 넣은 뒤
브라우저 워커의 공식 SQLite WASM `:memory:` 데이터베이스에서 실행하세요.
한국어와 다른 유니코드 계좌 이름을 포함한 결정적 금융 fixture를 사용합니다.

다음 작업을 직접 해 볼 수 있습니다.

- 원하는 조건과 JOIN을 포함한 `SELECT` 문 실행
- 일회용 데이터베이스에서 `INSERT`, `UPDATE` 등 한 문장 명령 실행
- SQLite 문법/실행 오류를 확인한 뒤 SQL을 고쳐 다시 실행
- **Inspect schema** 버튼으로 seed table 정의 확인
- 변경 후 **Reset seeded database** 버튼으로 원래 데이터 복원

문서 사이트에서 렌더링된 [인터랙티브 미리보기](https://clickin.github.io/SQLBraid/latest/ko/interactive-preview/)를 사용할 수 있습니다.

결과 표는 탐색 쿼리의 반응성을 위해 최대 1,000행까지만 표시합니다.
쿼리가 10초를 넘기면 워커를 교체하고 데이터베이스를 초기화합니다.

SQL은 일회용 브라우저 데이터베이스 안에서만 사용자 작성 raw text로
실행합니다. 서버 쿼리에 삽입하거나 injection 안전성을 주장하지 않으며
변경 사항도 저장하지 않습니다. OPFS, 영속성, `SharedArrayBuffer`,
COOP/COEP 헤더는 필요하지 않습니다.
