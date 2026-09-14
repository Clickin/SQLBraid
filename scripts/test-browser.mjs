import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const port = Number(process.env.SQLBRAID_BROWSER_PORT ?? 4321);
const basePath = "/SQLBraid/dev";
const route = `${basePath}/interactive-preview/`;
const externalUrl = process.env.SQLBRAID_BROWSER_URL;
const children = [];
const repositoryRoot = resolve(process.cwd());

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

async function runWasmConformance(browser, fixtureUrl) {
  const page = await browser.newPage();
  let pageError;
  page.on("pageerror", (error) => { pageError = error; });
  try {
    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    try {
      await page.waitForFunction(
        () => window.__sqlbraidWasmConformance !== undefined || window.__sqlbraidWasmConformanceError !== undefined,
        undefined,
        { timeout: 30_000 },
      );
    } catch (error) {
      throw new Error(`Browser WASM fixture did not become ready: ${pageError?.message ?? String(error)}`);
    }
    const result = await page.evaluate(() => ({
      report: window.__sqlbraidWasmConformance,
      error: window.__sqlbraidWasmConformanceError,
    }));
    if (result.error !== undefined) throw new Error(`Browser WASM conformance failed: ${result.error}`);
    if (result.report === undefined) throw new Error("Browser WASM conformance did not produce a report.");
    return result.report;
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
            viewportWidth: viewport.getBoundingClientRect().width,
            documentWidth: document.documentElement.scrollWidth,
            windowWidth: innerWidth,
          };
        });
        if (geometry.renderedRows > 20 || geometry.rowHeights.some((height) => height !== 56)) throw new Error("Support matrix lost bounded fixed-height virtualization.");
        if (geometry.documentWidth > geometry.windowWidth) throw new Error("Support matrix overflows the document.");
        measurements.push({ locale, view, ...geometry });
      }
      await matrix.locator('[data-index="0"]').focus();
      await page.keyboard.press("End");
      const focused = await page.evaluate(() => Number(document.activeElement.dataset.index));
      if (focused !== measurements.at(-1).totalRows - 1) throw new Error("Support matrix keyboard cannot reach the last virtual row.");
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-view="database"]').click();
      await matrix.locator("[data-search]").fill("mysql-mysql2");
      if (await matrix.locator("[data-index]").count() !== 1) throw new Error("Support matrix search did not isolate the MySQL target.");
      await matrix.locator("[data-reset]").click();
      await matrix.locator('[data-filter="database"]').selectOption("postgres");
      if ((await matrix.locator("[data-index]").allTextContents()).some((text) => !text.includes("postgres"))) throw new Error("Support matrix database filter leaked another engine.");
      await matrix.locator("[data-reset]").click();
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
    await writeFile(resolve(directory, "report.md"), "# Support matrix browser evidence\n\nEN/KO database, driver and capability views; bounded rows; End navigation; search and database filtering; 375px mobile layout; print and no-JavaScript fallback passed.\n");
    return { directory, measurements };
  } finally {
    await page.close();
  }
}

async function main() {
  let server;
  let fixtureServer;
  const url = externalUrl ?? `http://127.0.0.1:${port}${route}`;
  try {
    if (!externalUrl) {
      const env = {
        ...process.env,
        SQLBRAID_DOCS_CHANNEL: "dev",
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

    fixtureServer = await startFixtureServer();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      const preview = page.getByTestId("interactive-preview");
      await preview.waitFor();
      const source = preview.getByTestId("preview-source");
      if (!(await source.textContent()).includes("@braid if")) throw new Error("Preview source does not show @braid lowering.");

      const runButton = preview.getByRole("button", { name: "Run query" });
      const status = preview.getByTestId("preview-status");
      const rendered = preview.getByTestId("preview-rendered");
      const binds = preview.getByTestId("preview-binds");
      const table = preview.getByTestId("preview-table");
      const korean = preview.locator("[data-preview-korean]");
      const minimum = preview.locator("[data-preview-minimum]");
      const ownershipRun = preview.getByTestId("browser-ownership-run");
      const ownershipStatus = preview.getByTestId("browser-ownership-status");

      await runButton.click();
      await page.waitForFunction(() => document.querySelector("[data-testid='preview-status']")?.textContent?.includes("1 account") ?? false);
      if (!(await rendered.textContent()).includes("locale = ?")) throw new Error("Korean branch was not rendered.");
      if ((await binds.textContent()).trim() !== '[\n  "ko-KR",\n  1000000\n]') throw new Error("Unexpected Korean filter binds.");
      const firstRows = await table.textContent();
      if (!firstRows.includes("한빛증권") || !firstRows.includes("balanceLabel")) {
        throw new Error("Expected Korean finance row or Standard Schema transformation is missing.");
      }

      await korean.uncheck();
      await runButton.click();
      await page.waitForFunction(() => document.querySelector("[data-testid='preview-status']")?.textContent?.includes("3 accounts") ?? false);
      if ((await rendered.textContent()).includes("locale = ?")) throw new Error("Inactive Korean branch rendered SQL.");
      if ((await binds.textContent()).trim() !== "[\n  1000000\n]") throw new Error("Unexpected unfiltered binds.");
      const rows = await table.textContent();
      if (!rows.includes("東京パートナーズ") || !rows.includes("Seoul Capital") || rows.includes("푸른은행")) {
        throw new Error("Filter result rows are incorrect.");
      }

      await minimum.fill("-1");
      await runButton.click();
      await page.waitForFunction(() => document.querySelector("[data-testid='preview-status']")?.textContent?.includes("PREVIEW_INPUT") ?? false);
      if (!(await preview.getByTestId("preview-error").textContent()).includes("non-negative")) {
        throw new Error("Invalid filter did not produce the expected worker error.");
      }

      await ownershipRun.evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
      await page.waitForFunction(() => document.querySelector("[data-testid='browser-ownership-status']")?.textContent?.includes("passed") ?? false);
      const checks = (await ownershipStatus.getAttribute("data-checks") ?? "").split(",").filter(Boolean);
      const expectedChecks = ["nested-tx", "root-escape", "stream-ownership", "mapper-reentry", "break-cleanup", "error-cleanup", "concurrent-branches", "bulk-conformance:prepared-loop"];
      if (checks.join(",") !== expectedChecks.join(",")) throw new Error(`Unexpected browser ownership checks: ${checks.join(",")}.`);
      console.log(`Browser preview passed: ${url}`);
      const report = await runWasmConformance(browser, fixtureServer.url);
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
