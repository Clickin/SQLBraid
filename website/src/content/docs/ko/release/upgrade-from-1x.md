---
title: 1.x에서 2.0으로 업그레이드
description: 제거된 sqlbraid 드라이버 하위 경로를 방언·어댑터 패키지로 바꾸는 방법입니다.
---

SQLBraid 2.0은 `sqlbraid` 패키지의 드라이버·방언 하위 경로를 제거합니다. 쿼리 API와 런타임 동작은 바뀌지 않습니다. 업그레이드에서 바꿀 것은 설치하는 패키지와 import 경로뿐입니다.

`2.0.0`이 되는 것은 `sqlbraid`뿐입니다. 다른 자체 패키지는 각자의 버전 계열을 유지합니다.

## 무엇이 바뀌나요

1.x의 `sqlbraid`는 모든 방언·어댑터 패키지에 의존했습니다. `sqlbraid/node-sqlite` 같은 하위 경로는 어댑터 생성 함수와 `sql` 태그를 함께 내보냈습니다.

2.0의 `sqlbraid`에는 `sqlbraid`와 `sqlbraid/compiled` 진입점만 있습니다. 의존성은 `@sqlbraid/core`, `@sqlbraid/runtime`, `@sqlbraid/template`입니다. 옛 하위 경로는 없고, 호환용 별칭도 없습니다.

옛 하위 경로 하나는 이제 두 가지로 나뉩니다.

- 방언 패키지의 루트가 `sql`, `dialect`, `typePolicy`, 표현 프로필 상수, 파라미터 힌트를 내보냅니다.
- 같은 패키지의 어댑터 하위 경로가 `createNodeSqliteDatabase` 같은 생성 함수를 내보냅니다.

외부 드라이버는 바뀌지 않습니다. 지금 쓰는 `pg`, `mysql2`, `oracledb`, `tedious` 버전을 그대로 쓰세요.

## 1. 옛 import 찾기

프로젝트 루트에서 다음 명령을 실행하세요.

```bash
grep -rEn "from \"sqlbraid/(pg|postgres|mysql2|mysql|mariadb|node-sqlite|better-sqlite3|libsql|sqlite-wasm|d1|sqlite|oracledb|oracle|tedious|mssql|bun-sql)\"" src
```

`sqlbraid`와 `sqlbraid/compiled`의 import는 그대로 두세요. 나머지 결과는 모두 바꿉니다.

## 2. 패키지 설치

애플리케이션이 쓰는 데이터베이스마다 방언 패키지를 설치하세요. 공용 타입과 런타임 생성 함수 때문에 `sqlbraid`도 유지합니다.

```bash
pnpm add sqlbraid@2 @sqlbraid/sqlite@latest
```

이미 쓰는 `@sqlbraid/*` 패키지도 같은 명령에서 함께 올리세요. 그래야 모든 패키지가 `@sqlbraid/core` 사본 하나를 공유합니다. 패키지별 최소 버전은 [릴리스 노트](/SQLBraid/release/notes/#패키지-버전)에 있습니다.

데이터베이스에 맞는 패키지를 표에서 고르세요.

| 1.x 하위 경로             | 2.0 생성 함수 import              | 2.0 방언 import      | 설치할 패키지        |
| ------------------------- | --------------------------------- | -------------------- | -------------------- |
| `sqlbraid/pg`             | `@sqlbraid/postgres/pg`           | `@sqlbraid/postgres` | `@sqlbraid/postgres` |
| `sqlbraid/postgres`       | 없음                              | `@sqlbraid/postgres` | `@sqlbraid/postgres` |
| `sqlbraid/mysql2`         | `@sqlbraid/mysql/mysql2`          | `@sqlbraid/mysql`    | `@sqlbraid/mysql`    |
| `sqlbraid/mysql`          | 없음                              | `@sqlbraid/mysql`    | `@sqlbraid/mysql`    |
| `sqlbraid/mariadb`        | `@sqlbraid/mariadb/mariadb`       | `@sqlbraid/mariadb`  | `@sqlbraid/mariadb`  |
| `sqlbraid/node-sqlite`    | `@sqlbraid/sqlite/node-sqlite`    | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/better-sqlite3` | `@sqlbraid/sqlite/better-sqlite3` | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/libsql`         | `@sqlbraid/sqlite/libsql`         | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/sqlite-wasm`    | `@sqlbraid/sqlite/wasm`           | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/d1`             | `@sqlbraid/sqlite/d1`             | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/sqlite`         | 없음                              | `@sqlbraid/sqlite`   | `@sqlbraid/sqlite`   |
| `sqlbraid/oracledb`       | `@sqlbraid/oracle/oracledb`       | `@sqlbraid/oracle`   | `@sqlbraid/oracle`   |
| `sqlbraid/oracle`         | 없음                              | `@sqlbraid/oracle`   | `@sqlbraid/oracle`   |
| `sqlbraid/tedious`        | `@sqlbraid/mssql/tedious`         | `@sqlbraid/mssql`    | `@sqlbraid/mssql`    |
| `sqlbraid/mssql`          | 없음                              | `@sqlbraid/mssql`    | `@sqlbraid/mssql`    |
| `sqlbraid/bun-sql`        | `@sqlbraid/bun-sql`               | 선택한 방언          | `@sqlbraid/bun-sql`  |

Bun.SQL에서는 선택한 방언 패키지에서 `sql`을 import하고, 방언을 어댑터에 명시적으로 넘기세요. [현재 제한 사항](/SQLBraid/release/limitations/)을 참고하세요.

## 3. import 바꾸기

옛 import 하나를 생성 함수 import와 방언 import로 나누세요.

<!-- doc-snippet: skip -->

```ts
// 1.x
import { createNodeSqliteDatabase, sql } from "sqlbraid/node-sqlite";
```

```ts
// 2.0
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";
```

모든 드라이버에 같은 규칙을 적용합니다. 방언을 설정하는 이름은 방언 패키지에서 가져옵니다. `sql`, `typePolicy`, `postgresParameter`, `MYSQL2_NATIVE`가 그 예입니다. 드라이버로 데이터베이스를 만드는 이름은 어댑터 하위 경로에서 가져옵니다.

## 4. 결과 확인

타입 검사와 테스트를 실행하세요.

```bash
pnpm exec tsc --noEmit
```

옛 import는 다음 오류 중 하나로 실패합니다.

- TypeScript가 `Cannot find module 'sqlbraid/node-sqlite'`를 보고합니다.
- Node가 `ERR_PACKAGE_PATH_NOT_EXPORTED`를 보고합니다.

## 다른 패키지

- `@sqlbraid/migrate`는 `0.1.1`에서 `0.2.0`으로 올라갑니다.
- `@sqlbraid/compiler`와 `@sqlbraid/cli`는 `1.1.0`으로 올리세요. 이전 compiler는 제거된 하위 경로만 인식합니다.
- 컴파일된 쿼리를 쓰는 애플리케이션에는 `@sqlbraid/template`을 직접 의존성으로 설치하세요.

전체 변경 목록은 [릴리스 노트](/SQLBraid/release/notes/)를 보세요.
