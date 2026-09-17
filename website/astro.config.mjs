import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sqlbraid from "@sqlbraid/vite";
import { fileURLToPath } from "node:url";
import { rewriteLegacyBaseLinks } from "../scripts/docs-history.mjs";

const publicRoot = "/SQLBraid";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const channel = process.env.SQLBRAID_DOCS_CHANNEL ?? "latest";
const version = process.env.SQLBRAID_DOCS_VERSION?.trim() ?? "";
const configuredBase = process.env.SQLBRAID_DOCS_BASE?.trim() || (channel === "release" && version
  ? `${publicRoot}/v/${version}`
  : `${publicRoot}/latest`);

if (channel !== "latest" && channel !== "release") {
  throw new Error(`SQLBRAID_DOCS_CHANNEL must be "latest" or "release", received ${JSON.stringify(channel)}.`);
}
if (channel === "release" && !semver.test(version)) {
  throw new Error(`SQLBRAID_DOCS_VERSION must be a SemVer for a release build, received ${JSON.stringify(version)}.`);
}
if (channel === "latest" && version) {
  throw new Error("SQLBRAID_DOCS_VERSION is only valid for release builds.");
}

const base = configuredBase.replace(/\/+$/u, "") || "/";
const expectedBase = channel === "release" ? `${publicRoot}/v/${version}` : `${publicRoot}/latest`;
if (base !== expectedBase) {
  throw new Error(`SQLBRAID_DOCS_BASE must be ${expectedBase} for ${channel} builds, received ${configuredBase}.`);
}

function parseVersions(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`SQLBRAID_DOCS_VERSIONS must be JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !semver.test(entry))) {
    throw new Error("SQLBRAID_DOCS_VERSIONS must be a JSON array of SemVer strings.");
  }
  return [...new Set(parsed)];
}

parseVersions(process.env.SQLBRAID_DOCS_VERSIONS);
const stable = process.env.SQLBRAID_DOCS_STABLE?.trim() || "";
if (stable && !semver.test(stable)) throw new Error(`SQLBRAID_DOCS_STABLE must be SemVer, received ${JSON.stringify(stable)}.`);

const rewriteLinks = {
  name: "sqlbraid-versioned-links",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      await rewriteLegacyBaseLinks(fileURLToPath(dir), base);
    },
  },
};

export default defineConfig({
  site: "https://clickin.github.io/SQLBraid",
  base,
  vite: {
    plugins: [sqlbraid()],
    optimizeDeps: {
      exclude: ["@sqlite.org/sqlite-wasm"],
    },
  },
  integrations: [
    rewriteLinks,
    starlight({
      title: "SQLBraid",
      description: "Write SQL. Keep TypeScript. Skip the query-builder translation layer.",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
      },
      components: {
        SocialIcons: "./src/components/DocsVersionSelect.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Clickin/SQLBraid" }],
      sidebar: [
        { label: "Interactive preview", translations: { ko: "인터랙티브 미리보기" }, link: "/interactive-preview/" },
        { label: "Get started", translations: { ko: "시작하기" }, items: [
          { label: "Five-minute SQLite", translations: { ko: "5분 SQLite 시작하기" }, link: "/getting-started/sqlite/" },
          { label: "PostgreSQL", link: "/getting-started/postgres/" },
          { label: "MySQL", link: "/getting-started/mysql/" },
          { label: "MariaDB", link: "/getting-started/mariadb/" },
          { label: "Browser SQLite and D1", translations: { ko: "브라우저 SQLite와 D1" }, link: "/getting-started/sqlite-browser/" },
          { label: "Oracle", link: "/getting-started/oracle/" },
          { label: "SQL Server", link: "/getting-started/mssql/" },
          { label: "Vite", translations: { ko: "Vite" }, link: "/getting-started/vite/" },
        ] },
        { label: "Core concepts", translations: { ko: "핵심 개념" }, items: [
          { label: "SQL tags and result kinds", translations: { ko: "SQL 태그와 결과 종류" }, link: "/concepts/sql-tags/" },
          { label: "Safe binds", translations: { ko: "안전한 바인딩" }, link: "/concepts/safe-binds/" },
          { label: "Parameter type hints", translations: { ko: "매개변수 타입 힌트" }, link: "/concepts/parameter-hints/" },
          { label: "Dynamic @braid", translations: { ko: "동적 @braid" }, link: "/concepts/dynamic-braid/" },
          { label: "Structural SQL fragments", translations: { ko: "구조적 SQL 조각" }, link: "/concepts/structural-fragments/" },
          { label: "Routine calls", translations: { ko: "루틴 호출" }, link: "/concepts/routines/" },
          { label: "Homogeneous bulk DML", translations: { ko: "동종 bulk DML" }, link: "/concepts/bulk/" },
          { label: "Data representations", translations: { ko: "데이터 표현" }, link: "/concepts/data-representation/" },
          { label: "Standard Schema mapping", translations: { ko: "Standard Schema 매핑" }, link: "/concepts/result-mapping/" },
        ] },
        { label: "Runtime", translations: { ko: "런타임" }, items: [
          { label: "Direct connections and pools", translations: { ko: "직접 연결과 풀" }, link: "/runtime/direct-pools/" },
          { label: "Transactions and savepoints", translations: { ko: "트랜잭션과 세이브포인트" }, link: "/runtime/transactions/" },
          { label: "Streaming", translations: { ko: "스트리밍" }, link: "/runtime/streaming/" },
          { label: "Prepared queries", translations: { ko: "준비된 쿼리" }, link: "/runtime/prepared/" },
          { label: "Execution observers", translations: { ko: "실행 옵저버" }, link: "/runtime/observers/" },
          { label: "OpenTelemetry integration", translations: { ko: "OpenTelemetry 통합" }, link: "/runtime/opentelemetry/" },
          { label: "Future transaction profiles", translations: { ko: "향후 트랜잭션 프로필" }, link: "/runtime/transaction-profiles/" },
        ] },
        { label: "Metadata and codegen", translations: { ko: "메타데이터와 코드 생성" }, items: [
          { label: "Inspectors and snapshots", translations: { ko: "인스펙터와 스냅샷" }, link: "/metadata/inspectors/" },
          { label: "Codegen configuration", translations: { ko: "코드 생성 설정" }, link: "/metadata/config/" },
          { label: "Row / Insert / Update models", translations: { ko: "Row / Insert / Update 모델" }, link: "/metadata/models/" },
          { label: "Overrides and filters", translations: { ko: "오버라이드와 필터" }, link: "/metadata/overrides/" },
          { label: "codegen --check in CI", translations: { ko: "CI의 codegen --check" }, link: "/metadata/ci/" },
        ] },
        { label: "Agents and editors", translations: { ko: "에이전트와 에디터" }, items: [
          { label: "Agent-native LSP", translations: { ko: "에이전트 네이티브 LSP" }, link: "/agents/lsp/" },
          { label: "CLI inspect fallback", translations: { ko: "CLI inspect 대안" }, link: "/agents/cli/" },
          { label: "Portable skill", translations: { ko: "이식 가능한 스킬" }, link: "/agents/skill/" },
          { label: "VS Code extension", translations: { ko: "VS Code 확장" }, link: "/agents/vscode/" },
          { label: "Driver authoring", translations: { ko: "드라이버 작성 가이드" }, link: "/agents/driver-author/" },
        ] },
        { label: "Reference", translations: { ko: "레퍼런스" }, items: [
          { label: "Package map", translations: { ko: "패키지 구성" }, link: "/reference/packages/" },
          { label: "Runtime and driver support", translations: { ko: "런타임과 드라이버 지원" }, link: "/reference/support/" },
          { label: "Diagnostics and error codes", translations: { ko: "진단과 오류 코드" }, link: "/reference/errors/" },
          { label: "Configuration", translations: { ko: "설정" }, link: "/reference/configuration/" },
          { label: "Troubleshooting", translations: { ko: "문제 해결" }, link: "/reference/troubleshooting/" },
        ] },
        { label: "Release", translations: { ko: "릴리스" }, items: [
          { label: "1.0.0-rc.2 notes", translations: { ko: "1.0.0-rc.2 릴리스 노트" }, link: "/release/notes/" },
          { label: "Current limitations", translations: { ko: "현재 제한 사항" }, link: "/release/limitations/" },
          { label: "Roadmap", translations: { ko: "로드맵" }, link: "/release/roadmap/" },
        ] },
      ],
    }),
  ],
});
