import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const configuredPort = process.env.SQLBRAID_BROWSER_PORT === undefined
  ? undefined
  : Number(process.env.SQLBRAID_BROWSER_PORT);
const basePath = "/SQLBraid/latest";
const route = `${basePath}/interactive-preview/`;
const externalUrl = process.env.SQLBRAID_BROWSER_URL;
const children = [];
const repositoryRoot = resolve(process.cwd());

function certificationOptions() {
  const sourceSha = process.env.SQLBRAID_CERT_SOURCE_SHA;
  const artifactPath = process.env.SQLBRAID_CERT_ARTIFACT;
  const stressValue = process.env.SQLBRAID_CERT_STRESS;
  const requested = sourceSha !== undefined || artifactPath !== undefined || stressValue !== undefined;
  if (!requested) return undefined;
  if (sourceSha === undefined || artifactPath === undefined) {
    throw new Error("Certification mode requires SQLBRAID_CERT_SOURCE_SHA and SQLBRAID_CERT_ARTIFACT.");
  }
  if (stressValue !== undefined && !["0", "1", "false", "true"].includes(stressValue)) {
    throw new Error("SQLBRAID_CERT_STRESS must be 0, 1, false, or true.");
  }
  return {
    sourceSha,
    stress: stressValue === "1" || stressValue === "true",
    artifactPath: resolve(repositoryRoot, artifactPath),
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    children.push(child);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}.`));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview process may need a few seconds to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function probePort(port) {
  const probe = createServer();
  let listening = false;
  try {
    await new Promise((resolvePort, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        listening = true;
        resolvePort();
      });
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Preview port probe did not expose a TCP port.");
    return address.port;
  } finally {
    if (listening) {
      await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
    }
  }
}

async function previewPort() {
  if (configuredPort !== undefined) {
    try {
      return await probePort(configuredPort);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  return probePort(0);
}

function contentType(file) {
  return {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".wasm": "application/wasm",
  }[extname(file)] ?? "application/octet-stream";
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const relativePath = requestPath === "/" ? "fixtures/sqlite-browser/index.html" : requestPath.slice(1);
      const requested = resolve(repositoryRoot, relativePath);
      if (requested !== repositoryRoot && !requested.startsWith(`${repositoryRoot}/`)) {
        response.writeHead(403).end();
        return;
      }
      const file = (await stat(requested)).isDirectory() ? resolve(requested, "index.html") : requested;
      response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end(String(error));
    }
  });
  await new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fixture server did not expose a TCP port.");
  }
  return { server, url: `http://127.0.0.1:${address.port}/fixtures/sqlite-browser/` };
}

async function buildBrowserCertificationBundle() {
  const { build } = await import("vite");
  const directory = await mkdtemp(resolve(tmpdir(), "sqlbraid-browser-certification-"));
  await build({
    configFile: false,
    resolve: { conditions: ["browser", "import"] },
    build: {
      outDir: directory,
      emptyOutDir: true,
      lib: {
        entry: resolve(repositoryRoot, "fixtures/sqlite-browser/certification-entry.ts"),
        formats: ["iife"],
        name: "SQLBraidBrowserCertification",
        fileName: "certification.js",
      },
      minify: false,
    },
  });
  return resolve(directory, "certification.js.iife.js");
}

async function runWasmConformance(browser, fixtureUrl, certificationBundle, sourceSha, stress) {
  const page = await browser.newPage();
  let pageError;
  page.on("pageerror", (error) => { pageError = error; });
  try {
    const certificationUrl = new URL(fixtureUrl);
    certificationUrl.searchParams.set("sourceSha", sourceSha);
    certificationUrl.searchParams.set("stress", stress ? "1" : "0");
    await page.goto(certificationUrl, { waitUntil: "networkidle" });
    try {
      await page.waitForFunction(
        () => window.__sqlbraidWasmConformance !== undefined || window.__sqlbraidWasmConformanceError !== undefined,
        undefined,
        { timeout: 30_000 },
      );
    } catch (error) {
      throw new Error(`Browser WASM fixture did not become ready: ${pageError?.message ?? String(error)}`);
    }
    await page.waitForFunction(() => window.__sqlbraidSqlite3 !== undefined, undefined, { timeout: 30_000 });
    await page.addScriptTag({ path: certificationBundle });
    await page.waitForFunction(
      () => window.__sqlbraidCertificationArtifact !== undefined || window.__sqlbraidCertificationError !== undefined,
      undefined,
      { timeout: 120_000 },
    );
    const result = await page.evaluate(() => ({
      report: window.__sqlbraidWasmConformance,
      error: window.__sqlbraidWasmConformanceError,
      certification: window.__sqlbraidCertificationArtifact,
      certificationError: window.__sqlbraidCertificationError,
      certificationEvidence: window.__sqlbraidWasmCertificationEvidence,
    }));
    if (result.error !== undefined) throw new Error(`Browser WASM conformance failed: ${result.error}`);
    if (result.report === undefined) throw new Error("Browser WASM conformance did not produce a report.");
    if (result.certificationError !== undefined) throw new Error(`Browser WASM certification failed: ${result.certificationError}`);
    if (result.certification === undefined) throw new Error("Browser WASM certification did not produce an artifact.");
    return { ...result.report, certification: result.certification, certificationEvidence: result.certificationEvidence };
  } finally {
    await page.close();
  }
}

async function supportMatrix(browser, previewUrl) {
  const directory = await mkdtemp(resolve(tmpdir(), "sqlbraid-support-matrix-"));
  const measurements = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const englishUrl = new URL("../reference/support/", previewUrl).href;
  try {
    for (const locale of ["en", "ko"]) {
      await page.goto(locale === "en" ? englishUrl : new URL("../ko/reference/support/", previewUrl).href);
      const matrix = page.locator("support-matrix.is-ready");
      await matrix.waitFor();
      for (const view of ["database", "driver", "capability"]) {
        await matrix.locator(`[data-view="${view}"]`).click();
        const geometry = await matrix.evaluate((element) => {
          const viewport = element.querySelector("[data-viewport]");
          const rows = [...element.querySelectorAll("[data-index]")];
          return {
            totalRows: Number(viewport.getAttribute("aria-rowcount")) - 1,
            renderedRows: rows.length,
            rowHeights: rows.map((row) => row.getBoundingClientRect().height),
            rowGaps: rows.slice(1).map((row, index) => row.getBoundingClientRect().top - rows[index].getBoundingClientRect().bottom),
            viewportWidth: viewport.getBoundingClientRect().width,
            documentWidth: document.documentElement.scrollWidth,
            windowWidth: innerWidth,
          };
        });
        if (geometry.renderedRows > 20 || geometry.rowHeights.some((height) => height !== 56) || geometry.rowGaps.some((gap) => gap !== 0)) throw new Error("Support matrix lost bounded fixed-height virtualization.");
        if (geometry.documentWidth > geometry.windowWidth) throw new Error("Support matrix overflows the document.");
        measurements.push({ locale, view, ...geometry });
      }
      await matrix.locator('[data-view="database"]').click();
      await matrix.locator('[data-index="0"]').focus();
      const selectedDatabaseTab = matrix.locator('[role="tab"][data-view="database"]');
      const databaseTotalRows = measurements.findLast((measurement) => measurement.locale === locale && measurement.view === "database").totalRows;
      if (await selectedDatabaseTab.getAttribute("aria-selected") !== "true") throw new Error("Support matrix database tab was not selected before row keyboard navigation.");
      await page.keyboard.press("Home");
      const firstFocused = await page.evaluate(() => Number(document.activeElement.dataset.index));
      if (firstFocused !== 0 || await selectedDatabaseTab.getAttribute("aria-selected") !== "true") throw new Error("Support matrix row Home was interpreted as tab navigation.");
      await page.keyboard.press("End");
      const focused = await page.evaluate(() => Number(document.activeElement.dataset.index));
      if (focused !== databaseTotalRows - 1 || await selectedDatabaseTab.getAttribute("aria-selected") !== "true") throw new Error("Support matrix row End was interpreted as tab navigation.");
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-view="database"]').click();
      await matrix.locator("[data-search]").fill("mysql-mysql2-deno-2-9-3");
      const searchRows = await matrix.locator("[data-index]").allTextContents();
      if (searchRows.length !== 1 || !searchRows[0].includes("mysql-mysql2-deno-2-9-3")) throw new Error("Support matrix search did not isolate the requested runtime tuple.");
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-filter="database"]').selectOption("postgres");
      if ((await matrix.locator("[data-index]").allTextContents()).some((text) => !text.includes("postgres"))) throw new Error("Support matrix database filter leaked another engine.");
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-view="driver"]').click();
      await matrix.locator('[data-filter="profile"]').selectOption("mysql2-lossless-text");
      const profileRows = await matrix.locator("[data-index]").allTextContents();
      const expectedProfileTargets = await page.locator("[data-support-matrix]").evaluate((element) =>
        JSON.parse(element.textContent).targets.filter((target) => target.driver.profile === "mysql2-lossless-text").map((target) => target.id));
      if (profileRows.length !== expectedProfileTargets.length
        || expectedProfileTargets.some((id) => !profileRows.some((row) => row.includes(id)))
        || profileRows.some((row) => !row.includes("mysql2-lossless-text"))) throw new Error("Support matrix profile filter lost a runtime tuple or leaked another profile.");
      measurements.push({ locale, view: "profile-filter", profile: "mysql2-lossless-text", rows: profileRows.length });
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-view="capability"]').click();
      const capabilityStatusOptions = await matrix.locator('[data-filter="status"] option').evaluateAll((options) => options.map((option) => option.value));
      if (!capabilityStatusOptions.includes("guarded") || !capabilityStatusOptions.includes("guaranteed")) throw new Error("Capability view status filter did not expose capability statuses.");
      await matrix.locator('[data-filter="status"]').selectOption("guarded");
      const expectedGuardedRows = await page.locator("[data-support-matrix]").evaluate((element) =>
        JSON.parse(element.textContent).targets.reduce((count, target) => count + Object.values(target.capabilities).filter((capability) => capability.status === "guarded").length, 0));
      const guardedResult = await matrix.evaluate((element) => ({
        totalRows: Number(element.querySelector("[data-viewport]").getAttribute("aria-rowcount")) - 1,
        renderedStatuses: [...element.querySelectorAll("[data-index] [data-status]")].map((status) => status.getAttribute("data-status")),
      }));
      if (guardedResult.totalRows !== expectedGuardedRows || guardedResult.renderedStatuses.length === 0
        || guardedResult.renderedStatuses.some((status) => status !== "guarded")) throw new Error("Capability status filter leaked a non-guarded row or lost guarded capability rows.");
      measurements.push({ locale, view: "capability-status-filter", status: "guarded", rows: guardedResult.totalRows });
      await matrix.locator('[data-view="database"]').click();
      if (await matrix.locator('[data-filter="status"]').inputValue() !== "") throw new Error("Switching from capability to database view retained an invalid capability status filter.");
      await page.setViewportSize({ width: 375, height: 812 });
      await matrix.scrollIntoViewIfNeeded();
      const mobile = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, windowWidth: innerWidth }));
      if (mobile.documentWidth > mobile.windowWidth) throw new Error("Support matrix overflows a mobile viewport.");
      measurements.push({ locale, view: "mobile", ...mobile });
      await page.screenshot({ path: resolve(directory, `${locale}-mobile.png`) });
      await page.emulateMedia({ media: "print" });
      if (!(await page.locator(".support-matrix__fallback").isVisible()) || await matrix.locator(".support-matrix__interactive").isVisible()) throw new Error("Support matrix print fallback is incomplete.");
      await page.emulateMedia({ media: "screen" });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    try {
      const fallback = await noScript.newPage();
      await fallback.goto(englishUrl);
      if (!(await fallback.locator(".support-matrix__fallback").isVisible()) || await fallback.locator(".support-matrix__fallback tbody tr").count() !== measurements[0].totalRows) throw new Error("Support matrix no-JavaScript summary lost targets.");
    } finally {
      await noScript.close();
    }
    await writeFile(resolve(directory, "measurements.json"), JSON.stringify(measurements, null, 2));
    await writeFile(resolve(directory, "report.md"), "# Support matrix browser evidence\n\nEN/KO database, driver and capability views; bounded contiguous 56px rows; Home/End navigation; search, database, profile and capability-status filtering; 375px mobile layout; print and no-JavaScript fallback passed.\n");
    return { directory, measurements };
  } finally {
    await page.close();
  }
}

async function main() {
  let server;
  let fixtureServer;
  const certification = certificationOptions();
  const port = externalUrl === undefined ? await previewPort() : undefined;
  const url = externalUrl ?? `http://127.0.0.1:${port}${route}`;
  try {
    if (!externalUrl) {
      const env = {
        ...process.env,
        SQLBRAID_DOCS_CHANNEL: "latest",
        SQLBRAID_DOCS_VERSION: "",
        SQLBRAID_DOCS_BASE: basePath,
        ASTRO_PREVIEW_BACKGROUND: "0",
      };
      // Vitest exports its own "/" BASE_URL; let Astro resolve the docs base.
      delete env.BASE_URL;
      await run("pnpm", ["--dir", "website", "build"], { env });
      server = spawn("pnpm", ["--dir", "website", "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      children.push(server);
      await waitForServer(url);
    }

    if (certification !== undefined) fixtureServer = await startFixtureServer();
    const certificationBundle = certification === undefined ? undefined : await buildBrowserCertificationBundle();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      const preview = page.getByTestId("interactive-preview");
      await preview.waitFor();
      const editor = preview.getByTestId("preview-sql");
      const runButton = preview.getByTestId("preview-run");
      const status = preview.getByTestId("preview-status");
      const table = preview.getByTestId("preview-table");
      const ownershipRun = preview.getByTestId("browser-ownership-run");
      const ownershipStatus = preview.getByTestId("browser-ownership-status");

      const executeSql = async (text) => {
        await editor.fill(text);
        await runButton.click();
        await page.waitForFunction(() => !document.querySelector("[data-testid='preview-run']")?.disabled);
      };
      const cells = () => table.locator("tbody tr").evaluateAll((rows) =>
        rows.map((row) => [...row.cells].map((cell) => cell.textContent)));

      await preview.getByTestId("preview-schema").click();
      await page.waitForFunction(() => !document.querySelector("[data-testid='preview-run']")?.disabled);
      const schema = await preview.getByTestId("preview-schema-output").textContent();
      if (!schema.includes("finance_accounts") || !schema.includes("account_name")) {
        throw new Error("The SQL editor does not expose the available database schema.");
      }

      await executeSql("SELECT account_name FROM finance_accounts WHERE locale = 'ko-KR' ORDER BY account_id;");
      if (JSON.stringify(await cells()) !== JSON.stringify([["한빛증권"], ["푸른은행"]])) {
        throw new Error("User-authored SQL did not select the expected Unicode rows.");
      }
      await executeSql("SELECT a.account_name, b.account_name AS other FROM finance_accounts a JOIN finance_accounts b ON b.account_id = a.account_id + 1 WHERE a.account_id = 1;");
      if (JSON.stringify(await cells()) !== JSON.stringify([["한빛증권", "푸른은행"]])) {
        throw new Error("User-authored JOIN did not execute against the seeded database.");
      }
      await executeSql("SELECT FROM");
      if (!(await preview.getByTestId("preview-error").isVisible()) || !(await status.textContent()).includes("error")) {
        throw new Error("Invalid SQL did not expose the actual execution error.");
      }
      await executeSql("SELECT account_name FROM finance_accounts WHERE account_id = 3;");
      if (await preview.getByTestId("preview-error").isVisible() || JSON.stringify(await cells()) !== JSON.stringify([["東京パートナーズ"]])) {
        throw new Error("The SQL editor did not recover after a syntax error.");
      }
      await executeSql("UPDATE finance_accounts SET balance = 0 WHERE account_id = 1;");
      await executeSql("SELECT balance FROM finance_accounts WHERE account_id = 1;");
      if (JSON.stringify(await cells()) !== JSON.stringify([["0"]])) throw new Error("Edited SQL did not mutate the disposable database.");
      await preview.getByTestId("preview-reset").click();
      await page.waitForFunction(() => !document.querySelector("[data-testid='preview-run']")?.disabled);
      await executeSql("SELECT balance FROM finance_accounts WHERE account_id = 1;");
      if (JSON.stringify(await cells()) !== JSON.stringify([["1250000"]])) throw new Error("Database reset did not restore seeded data.");
      await executeSql("SELECT account_name FROM finance_accounts WHERE 0;");
      if ((await table.locator("thead th").allTextContents()).join(",") !== "account_name" || !(await table.textContent()).includes("No rows")) {
        throw new Error("An empty query result lost its column metadata.");
      }
      await executeSql("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1002) SELECT x FROM n;");
      if (await table.locator("tbody tr").count() !== 1000 || !(await status.textContent()).includes("first 1,000")) {
        throw new Error("The playground did not bound displayed results or disclose truncation.");
      }
      await editor.fill("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n) SELECT sum(x) FROM n;");
      await runButton.click();
      await preview.getByTestId("preview-reset").click();
      await executeSql("SELECT COUNT(*) AS count FROM finance_accounts;");
      if (JSON.stringify(await cells()) !== JSON.stringify([["4"]])) {
        throw new Error("Reset failed to interrupt busy SQL and restore the disposable database.");
      }

      await ownershipRun.evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
      await page.waitForFunction(() => document.querySelector("[data-testid='browser-ownership-status']")?.textContent?.includes("passed") ?? false);
      const checks = (await ownershipStatus.getAttribute("data-checks") ?? "").split(",").filter(Boolean);
      const expectedChecks = ["nested-tx", "root-escape", "stream-ownership", "mapper-reentry", "break-cleanup", "error-cleanup", "concurrent-branches", "bulk-conformance:prepared-loop"];
      if (checks.join(",") !== expectedChecks.join(",")) throw new Error(`Unexpected browser ownership checks: ${checks.join(",")}.`);
      console.log(`Browser preview passed: ${url}`);
      let report = await page.evaluate(() => window.__sqlbraidWasmConformance ?? {});
      if (certification !== undefined) {
        report = await runWasmConformance(browser, fixtureServer.url, certificationBundle, certification.sourceSha, certification.stress);
        if (report.certification.sourceSha !== certification.sourceSha) {
          throw new Error("Browser certification source SHA did not survive the fixture boundary.");
        }
        if (Object.keys(report.certification.cases ?? {}).length !== 84) {
          throw new Error(`Browser certification executed ${Object.keys(report.certification.cases ?? {}).length} cases instead of 84.`);
        }
        await writeFile(certification.artifactPath, JSON.stringify(report.certification, null, 2));
        const integerEvidence = report.cases?.["wasm.numeric.exact-integer"];
        if (!integerEvidence || Object.values(integerEvidence.values ?? {}).some((value) => value?.type !== "string")) {
          throw new Error("Browser WASM exact INTEGER evidence must use canonical strings.");
        }
        if (integerEvidence.realValues?.some((value) => value?.type !== "number")) {
          throw new Error("Browser WASM REAL evidence must remain JavaScript numbers.");
        }
        const jsonEvidence = report.cases?.["wasm.data.json-text"]?.rows?.[0]?.payload;
        if (typeof jsonEvidence !== "string" || !jsonEvidence.includes("9007199254740993")) {
          throw new Error("Browser WASM nested JSON must remain exact text.");
        }
      }
      console.log(`SQLBRAID_BROWSER_REPORT=${JSON.stringify({ ...report, browserVersion: browser.version(), matrix: await supportMatrix(browser, url) })}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (server?.pid && process.platform !== "win32") {
      try { process.kill(-server.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (fixtureServer !== undefined) {
      await new Promise((resolveServer) => fixtureServer.server.close(resolveServer));
    }
    for (const child of children.reverse()) {
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
