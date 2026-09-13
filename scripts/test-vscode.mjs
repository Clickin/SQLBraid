import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const env = { ...process.env };
const installed = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
if (!env.SQLBRAID_VSCODE_EXECUTABLE && process.platform === "darwin" && existsSync(installed)) env.SQLBRAID_VSCODE_EXECUTABLE = installed;
const runner = resolve("extensions/vscode/dist-test/test/runTest.js");
const headless = process.platform === "linux" && !process.env.DISPLAY;
const result = spawnSync(headless ? "xvfb-run" : process.execPath, headless ? ["-a", process.execPath, runner] : [runner], {
  cwd: resolve("extensions/vscode"), env, stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
