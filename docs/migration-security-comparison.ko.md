# 마이그레이션 도구의 보안 책임 비교

조사일: 2026-10-10.
공식 문서와 공개 소스를 비교했습니다. 다른 도구에 대한 침투 테스트나 실제 DB 실행 결과는 아닙니다.
SQLBraid의 JS/TS 보안 점검을 보완하는 사례 조사입니다.

마이그레이션 이력 검증과 웹 노출 차단은 별도 기능입니다.
체크섬과 잠금이 있어도 웹 서버가 SQL 파일을 공개하면 내용을 읽을 수 있습니다.
조사한 문서에서는 SQLBraid의 Vite 플러그인과 같은 `publicDir` 노출 차단 보장을 확인하지 못했습니다.
이는 각 제품 전체에 해당 방어가 없다는 증거가 아닙니다.

## 조사 범위와 버전

| 대상     | 확인한 기준                            | 해석 범위                                                    |
| -------- | -------------------------------------- | ------------------------------------------------------------ |
| Prisma 8 | 조사일의 공식 문서                     | 현재 문서의 설계입니다. 개별 npm 버전을 실행하지 않았습니다. |
| Prisma 7 | `/orm/v7`, `/cli/v7` 문서              | 기존 SQL 마이그레이션 경로입니다. v8과 구분합니다.           |
| Drizzle  | 현재 문서, `0.44.5` 소스               | 체크섬·잠금 분석은 고정한 PostgreSQL 구현에만 적용합니다.    |
| Knex     | 현재 문서, `3.1.0` 파일 로더           | 문서의 기능과 해당 로더 구현을 구분합니다.                   |
| TypeORM  | 현재 문서, `0.3.28` 실행기와 파일 로더 | 소스 분석 결과는 해당 버전에만 적용합니다.                   |
| Flyway   | 조사일의 공식 문서                     | 특정 릴리스 바이너리를 검증하지 않았습니다.                  |

Prisma는 현재 기본 문서를 v8으로 안내하며 v7도 지원한다고 설명합니다.
Drizzle의 v1 업그레이드 문서는 `@rc` 설치와 마이그레이션 폴더 변경을 안내합니다.
따라서 과거 버전 소스의 결론을 현재 모든 버전에 적용하지 않습니다.
[Prisma 버전 안내](https://docs.prisma.io/docs/orm), [Drizzle v1 안내](https://orm.drizzle.team/docs/upgrade-v1).

## Prisma

### v7의 SQL 파일과 배포 명령

v7은 `migration.sql` 파일과 `_prisma_migrations` 테이블로 이력을 관리합니다.
운영에서는 CI/CD의 `prisma migrate deploy` 실행을 권장합니다.
설정은 `prisma.config.ts`에서 읽습니다.
SQL 파일을 배포하더라도 설정 파일은 별도의 신뢰 대상입니다.
[이력](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/migration-histories),
[배포 명령](https://docs.prisma.io/docs/cli/v7/migrate/deploy).

`migrate deploy`는 적용한 파일이 변경되면 경고하고 남은 마이그레이션을 적용합니다.
이미 적용한 파일의 누락이나 실제 DB 스키마의 차이를 모두 검사하지는 않습니다.
PostgreSQL, MySQL, SQL Server에서는 advisory lock으로 동시 실행을 조정합니다.
문서의 잠금 제한 시간은 10초이며 환경 변수로 잠금을 끌 수 있습니다.
잠금이 모든 DB의 DDL 롤백을 보장한다는 뜻은 아닙니다.
[운영 배포와 잠금](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production).

### v8의 작성 단계와 운영 실행 단계

v8에서는 `migration.ts`를 작성하고 Node.js로 실행해 `ops.json`과 `migration.json`을 만듭니다.
`prisma db migrate`는 생성된 연산을 적용합니다.
공식 문서는 운영 자격 증명으로 `migration.ts`와 그 import를 실행하지 않는다고 명시합니다.
이는 작성용 TS 실행과 운영 SQL 실행을 분리하는 설계입니다.
설정 파일 전체가 샌드박스에서 실행된다는 보장으로 확대해서는 안 됩니다.
[편집과 컴파일](https://www.prisma.io/docs/orm/migrations/editing-a-migration),
[운영 적용](https://docs.prisma.io/docs/orm/migrations/applying-a-migration).

생성 산출물의 해시는 수동 변경을 검사합니다.
다만 TS를 편집하고 재컴파일하지 않은 상태까지 적용 시 자동 검증한다는 보장은 문서에 없습니다.
PostgreSQL에서는 전체 적용을 하나의 트랜잭션과 advisory lock으로 처리합니다.
MongoDB는 marker의 compare-and-swap과 재시도 검사를 사용합니다.
이 보장을 다른 DB에 그대로 적용하면 안 됩니다.
[산출물 해시](https://www.prisma.io/docs/orm/migrations/editing-a-migration),
[적용 범위와 현재 제한](https://docs.prisma.io/docs/orm/migrations/applying-a-migration).

두 버전의 확인한 배포 문서는 DB 변경 실행을 다룹니다.
Vite의 정적 파일 복사나 HTTP 접근을 차단한다는 약속은 이 문서에서 확인하지 못했습니다.

## Drizzle

Drizzle Kit은 JS/TS 스키마에서 SQL 파일을 생성하고 CLI로 적용할 수 있습니다.
`drizzle.config.ts`에는 설정 코드와 DB 연결 설정이 들어갑니다.
SQL 파일만 읽는 실행기와 TS 설정·스키마를 평가하는 도구의 신뢰 범위를 나눠야 합니다.
[마이그레이션 경로](https://orm.drizzle.team/docs/migrations),
[CLI 적용](https://orm.drizzle.team/docs/drizzle-kit-migrate).

`0.44.5`의 파일 로더는 SQL을 읽어 SHA-256을 계산합니다.
같은 버전의 PostgreSQL 실행기는 해시와 시간을 이력에 저장합니다.
적용 여부는 마지막 적용 시간으로 판단하며, 이 함수에는 기존 파일의 해시 비교가 없습니다.
대기 중인 SQL은 트랜잭션으로 실행하지만 별도의 migration lock 획득은 이 함수에서 확인되지 않습니다.
이 결과를 Drizzle Kit 전체나 최신 v1의 보장으로 일반화하지 않습니다.
[0.44.5 파일 로더](https://github.com/drizzle-team/drizzle-orm/blob/0.44.5/drizzle-orm/src/migrator.ts),
[0.44.5 PostgreSQL 실행기](https://github.com/drizzle-team/drizzle-orm/blob/0.44.5/drizzle-orm/src/pg-core/dialect.ts#L70-L107).

Drizzle은 Expo SQLite에서 SQL을 앱 번들에 문자열로 넣는 배포를 공식 안내합니다.
따라서 모든 마이그레이션을 서버에만 숨기는 정책은 Drizzle의 공통 전제가 아닙니다.
클라이언트의 로컬 DB를 위한 SQL과 운영 서버 DB를 위한 SQL을 구분해야 합니다.
확인한 문서는 서버 SQL의 `publicDir` 노출 차단을 약속하지 않습니다.
[Expo의 SQL 번들](https://orm.drizzle.team/docs/sqlite/connect-expo-sqlite).

## Knex

Knex는 JS/TS 마이그레이션의 `up`과 `down`을 호출합니다.
`knexfile`은 비동기 함수로 자격 증명을 구할 수도 있습니다.
따라서 마이그레이션과 설정은 실행 가능한 애플리케이션 코드로 취급해야 합니다.
파일 확장자를 제한해도 허용한 코드의 권한을 제한하는 샌드박스가 되지는 않습니다.
[설정과 실행](https://knexjs.org/guide/migrations.html#knexfile-js).

문서는 기본 트랜잭션 실행과 `disableTransactions` 설정을 설명합니다.
이력 목록 검증은 적용한 파일이 디렉터리에 남아 있는지 확인합니다.
이 설명만으로 파일 내용의 체크섬 검증까지 있다고 판단하면 안 됩니다.
잠금 테이블로 동시 실행을 조정하며 비정상 종료 뒤 수동 unlock이 필요할 수 있습니다.
[실행·검증 옵션](https://knexjs.org/guide/migrations.html#migration-api),
[잠금](https://knexjs.org/guide/migrations.html#notes-about-locks).

Knex는 사용자 정의 source와 Webpack 번들 예시도 제공합니다.
번들 지원은 번들 내용의 기밀성 보장이 아닙니다.
해당 문서에서는 웹 정적 경로를 검사하거나 막는 기능을 확인하지 못했습니다.
[번들 source](https://knexjs.org/guide/migrations.html#webpack-migration-source-example).

## TypeORM

TypeORM은 DataSource에 마이그레이션 클래스 또는 파일 glob을 지정합니다.
`0.3.28` 파일 로더는 검색 결과를 `importOrRequireFile`로 로드합니다.
마이그레이션 클래스와 DataSource 설정은 실행할 수 있는 JS/TS 코드입니다.
파일을 찾는 glob은 코드의 실행 권한을 제한하지 않습니다.
[설정](https://typeorm.io/docs/migrations/setup/),
[0.3.28 로더](https://github.com/typeorm/typeorm/blob/0.3.28/src/util/DirectoryExportedClassesLoader.ts).

기본 트랜잭션 모드는 `all`이며 `each`와 `none`도 지원합니다.
`0.3.28` 실행기의 이력 테이블은 `id`, `timestamp`, `name`을 기록합니다.
이 실행기에는 파일 체크섬 검증이나 별도 migration lock 획득이 없습니다.
따라서 이 구현의 트랜잭션만으로 여러 배포 프로세스의 직렬 실행을 주장할 수 없습니다.
[트랜잭션 모드](https://v0.typeorm.io/docs/migrations/faking/),
[0.3.28 실행기](https://github.com/typeorm/typeorm/blob/0.3.28/src/migration/MigrationExecutor.ts).

TypeORM은 브라우저의 sql.js와 여러 앱 런타임도 지원합니다.
이 지원이 서버 마이그레이션 파일을 자동으로 숨긴다는 뜻은 아닙니다.
확인한 배포·마이그레이션 문서에서는 정적 파일 노출 차단을 확인하지 못했습니다.
[플랫폼 범위](https://typeorm.io/docs/help/supported-platforms/).

## Flyway

Flyway는 SQL과 Java 마이그레이션을 지원합니다.
설정은 TOML을 사용할 수 있으므로 JS/TS 설정 실행과는 다릅니다.
Java 마이그레이션은 기본적으로 체크섬이 없으며 필요하면 직접 제공합니다.
SQL과 실행 가능한 확장 코드는 같은 검증 수준이라고 가정하면 안 됩니다.
[설정 파일](https://documentation.red-gate.com/flyway/flyway-concepts/flyway-projects),
[Java 마이그레이션](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/java-based-migrations).

SQL 검증은 이력에 저장한 CRC32와 현재 파일을 비교합니다.
이 값은 변경 감지용이며 작성자 인증이나 악성 SQL 검증을 제공하는 서명이 아닙니다.
Flyway는 DB 잠금으로 동시 실행을 조정합니다.
기본적으로 마이그레이션마다 트랜잭션을 사용하지만 DB의 DDL 제약을 따릅니다.
MySQL·Oracle의 암시적 커밋에서는 완전한 롤백을 보장하지 않습니다.
[검증](https://documentation.red-gate.com/flyway/reference/commands/validate),
[동시 실행](https://documentation.red-gate.com/flyway/reference/usage/frequently-asked-questions),
[트랜잭션](https://documentation.red-gate.com/flyway/flyway-concepts/migrations/migration-transaction-handling).

확인한 문서는 CLI·DB 실행과 이력을 다룹니다.
Vite 서버나 웹 배포 디렉터리의 SQL 노출 차단은 해당 문서에서 확인하지 못했습니다.

## 심볼릭 링크와 정적 파일

Knex `3.1.0`의 파일 검색은 디렉터리를 읽고 확장자를 필터링합니다.
Drizzle `0.44.5`는 journal의 경로로 `readFileSync`를 호출합니다.
TypeORM `0.3.28`은 glob 결과를 절대 경로로 만들어 import합니다.
이 함수들에는 SQLBraid의 웹 보호 경계에 해당하는 realpath 포함 여부 검사가 없습니다.
이는 해당 함수의 관찰 결과입니다. 각 제품의 모든 링크 정책을 조사한 결과는 아닙니다.
[Knex 로더](https://github.com/knex/knex/blob/3.1.0/lib/migrations/migrate/sources/fs-migrations.js),
[Drizzle 로더](https://github.com/drizzle-team/drizzle-orm/blob/0.44.5/drizzle-orm/src/migrator.ts),
[TypeORM 로더](https://github.com/typeorm/typeorm/blob/0.3.28/src/util/DirectoryExportedClassesLoader.ts).

Prisma와 Flyway의 전체 심볼릭 링크 정책은 이번 조사에서 확인하지 못했습니다.
지원 또는 거부로 분류하지 않습니다.
Vite는 `publicDir`을 개발 중 `/`에서 제공하고 빌드 결과로 그대로 복사합니다.
따라서 import 차단만으로 정적 파일 배포까지 보호할 수 없다는 결론은 Vite의 동작에서 나옵니다.
[Vite publicDir](https://vite.dev/config/shared-options#publicdir).

## SQLBraid에 적용할 판단

SQLBraid는 `.sql`만 마이그레이션으로 허용합니다.
로더는 심볼릭 링크를 따라가며 동일한 디렉터리를 중복 방문하면 거부합니다.
SQL은 신뢰하는 입력이며, 생성된 manifest의 체크섬은 실행 시 SQL에서 다시 계산하지 않습니다.
이 경계는 이미 문서와 코드에 있습니다.
[파일 로더](../packages/migrate/src/sources.ts), [신뢰·배포 설명](../packages/migrate/README.md).

반면 Vite 플러그인은 브라우저 import와 개발 서버의 SQL 접근을 거부하는 기능을 제공합니다.
이 기능은 SQLBraid가 직접 제공하는 웹 보호 경계입니다.
다른 도구가 같은 보장을 문서화하지 않았다는 이유로 SQLBraid의 우회를 허용할 수는 없습니다.
[Vite 플러그인](../packages/migrate/src/vite.ts).

이번 수정과 후속 검증은 다음 범위로 제한하는 것이 적절합니다.

1. `publicDir`의 링크가 보호 대상 SQL을 가리키면 빌드와 서버 시작 전에 거부하세요.
2. 개발 서버에서는 요청을 root와 `publicDir` 양쪽 경로로 해석해 보호 대상을 검사하세요.
3. 디렉터리 링크와 파일 링크를 실제 HTTP 요청과 클라이언트 빌드로 검증하세요.
4. 클라이언트 산출물과 공개 파일에 서버 SQL이 없는지 배포 단계에서도 확인하세요.
5. 신뢰하지 않는 설정·마이그레이션 실행 금지와 manifest 재생성 절차를 유지하세요.

별도 JS 샌드박스나 새 SQL 의미 분석기는 이 문제를 해결하는 데 필요하지 않습니다.
체크섬 재계산은 산출물의 우발적 변경을 찾는 별도 개선으로 검토할 수 있습니다.
공격자가 SQL과 체크섬을 함께 바꿀 수 있으면 재계산만으로 진위를 증명할 수 없습니다.
검토한 변경만 배포하는 절차와 산출물 접근 통제는 계속 필요합니다.

다른 제품의 실제 배포, 모든 DB 조합, 모든 버전과 링크 동작은 검증하지 않았습니다.
확인한 함수·문서 밖의 기능 부재나 취약성을 단정하지 않습니다.
