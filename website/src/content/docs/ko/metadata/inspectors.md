---
title: Inspector와 메타데이터 스냅샷
description: 검증되고 결정적인 SQLBraid 메타데이터로 데이터베이스 사실을 캡처합니다.
---

메타데이터는 선택적인 Node 우선 도구입니다. 런타임 dialect import는 메타데이터 또는 codegen 패키지를 설치하거나 요구하지 않습니다.

dialect, 드라이버, 선택적인 메타데이터 패키지를 명시적으로 설치하세요.

```bash
npm install @sqlbraid/postgres pg @sqlbraid/metadata
```

Inspector는 별도 패키지가 아니라 dialect 패키지의 **subpath export**입니다. 이미 연결된 물리 클라이언트를 검사하세요.

```ts
import { hashSnapshot, validateSnapshot } from "@sqlbraid/metadata";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";

const metadata = await createPostgresInspector(client).inspect();
validateSnapshot(metadata);
console.log(hashSnapshot(metadata));
```

모든 퍼스트 파티 dialect는 `/inspector` 서브패스에서 전용 inspector를 내보냅니다:
`createPostgresInspector` (`@sqlbraid/postgres/inspector`),
`createMysqlInspector` (`@sqlbraid/mysql/inspector`),
`createMariaDbInspector` (`@sqlbraid/mariadb/inspector`),
`createSqliteInspector` (`@sqlbraid/sqlite/inspector`),
`createOracleInspector` (`@sqlbraid/oracle/inspector`),
`createMssqlInspector` (`@sqlbraid/mssql/inspector`).
Inspector 서브패스는 dialect 루트와 의도적으로 분리되어 있습니다.

스냅샷은 다음 형식을 사용합니다.

```json
{ "format": "sqlbraid-metadata", "formatVersion": 1 }
```

스냅샷 형식은 namespace, 타입, 관계, 열, 제약 조건, 인덱스, 루틴, 서버 증거, 캡처 메타데이터를 표현할 수 있습니다. Inspector 지원 범위는 부분적입니다. 현재 PostgreSQL은 namespace를 비워 두며 관계 제약 조건이나 인덱스를 채우지 않습니다. 누락된 필드는 부재의 증거가 아닙니다. 정규화와 해싱은 캡처 타임스탬프를 무시하면서 데이터베이스 사실은 보존합니다. `validateSnapshot`은 잘못되었거나 오래된 식별자 없는 스냅샷을 거부하며, `sqlbraid drift --before ... --after ...`는 검증된 스냅샷을 비교합니다.

메타데이터는 데이터베이스 스키마 잠금이 아니라 증거입니다. 루틴의 `argumentsComplete: false`는 빈 인자 목록이 인자 수 0의 증명이 아님을 뜻합니다. SQLite는 루틴 레코드를 생성하지 않습니다. identity는 입증된 identity/autoincrement 생성이며 단순히 기본 키에 속한다는 뜻이 아닙니다. 쓰기 플래그를 알 수 없으면 계속 unknown으로 남습니다.
