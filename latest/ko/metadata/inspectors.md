# 인스펙터와 메타데이터 스냅샷

> 데이터베이스 정보를 검증된 결정적 SQLBraid 메타데이터로 수집합니다.

메타데이터는 선택 사항이며 Node 중심의 도구입니다. 런타임 방언을 import해도 메타데이터나 코드 생성 패키지가 설치되거나 필요해지지 않습니다.

방언, 드라이버, 선택 사항인 메타데이터 패키지를 명시적으로 설치하세요.

```bash
npm install @sqlbraid/postgres pg @sqlbraid/metadata
```

인스펙터는 별도 패키지가 아니라 방언 패키지의 **하위 경로 export**입니다. 이미 연결된 물리 클라이언트를 검사하세요.

```ts
import { hashSnapshot, validateSnapshot } from "@sqlbraid/metadata";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";

const metadata = await createPostgresInspector(client).inspect();
validateSnapshot(metadata);
console.log(hashSnapshot(metadata));
```

모든 공식 방언은 `/inspector` 하위 경로에서 전용 인스펙터를 export합니다.

- `createPostgresInspector` (`@sqlbraid/postgres/inspector`)
- `createMysqlInspector` (`@sqlbraid/mysql/inspector`)
- `createMariaDbInspector` (`@sqlbraid/mariadb/inspector`)
- `createSqliteInspector` (`@sqlbraid/sqlite/inspector`)
- `createOracleInspector` (`@sqlbraid/oracle/inspector`)
- `createMssqlInspector` (`@sqlbraid/mssql/inspector`)

인스펙터 하위 경로는 일부러 방언 루트와 분리했습니다.

스냅샷 형식은 다음과 같습니다.

```json
{ "format": "sqlbraid-metadata", "formatVersion": 1 }
```

스냅샷 형식은 네임스페이스, 타입, 릴레이션, 열, 제약, 인덱스, 루틴, 서버 근거, 수집 메타데이터를 표현할 수 있습니다.

- 인스펙터가 다루는 범위는 부분적입니다. PostgreSQL은 현재 네임스페이스를 비워 두고, 릴레이션의 제약이나 인덱스를 채우지 않습니다.
- 필드가 없다고 해서 해당 항목이 없다는 증거는 아닙니다.
- 정규화와 해시는 수집 시각을 무시하고 데이터베이스 정보만 반영합니다.
- `validateSnapshot`은 잘못된 스냅샷과, 구분자가 없는 예전 스냅샷을 거부합니다.
- `sqlbraid drift --before ... --after ...`는 검증된 스냅샷을 비교합니다.

메타데이터는 근거입니다. 데이터베이스 스키마를 잠그는 장치가 아닙니다.

- 루틴의 `argumentsComplete: false`는 인자 목록이 비어 있어도 인자가 0개라는 증거가 아니라는 뜻입니다.
- SQLite는 루틴 레코드를 내보내지 않습니다.
- identity는 identity나 autoincrement 생성이 증명되었다는 뜻입니다. 기본 키에 속한다는 것만으로는 identity가 아닙니다.
- 알 수 없는 쓰기 플래그는 알 수 없음으로 남습니다.
