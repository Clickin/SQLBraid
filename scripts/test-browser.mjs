import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const port = Number(process.env.SQLBRAID_BROWSER_PORT ?? 4321);
const basePath = "/SQLBraid/dev";
const route = `${basePath}/interactive-preview/`;
const externalUrl = process.env.SQLBRAID_BROWSER_URL;
const children = [];

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

async function main() {
  let server;
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
      await run("pnpm", ["--dir", "website", "build"], { env });
      server = spawn("pnpm", ["--dir", "website", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        env,
        stdio: "inherit",
      });
      children.push(server);
      await waitForServer(url);
    }

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
    } finally {
      await browser.close();
    }
  } finally {
    for (const child of children.reverse()) {
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
