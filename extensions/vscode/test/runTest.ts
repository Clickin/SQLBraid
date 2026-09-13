import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, "../..");
  const extensionTestsPath = resolve(__dirname, "./suite/index.js");
  const fixtureSourcePath = resolve(__dirname, "../../test/fixture");
  const vscodeExecutablePath = process.env.SQLBRAID_VSCODE_EXECUTABLE;

  async function dumpLogs(rootPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await dumpLogs(path);
      continue;
    }
    if (!entry.name.endsWith(".log")) continue;
    try {
      const text = await readFile(path, "utf8");
      console.error(`\n--- VSCode test log: ${path} ---\n${text.slice(-20_000)}`);
    } catch {
      // A log may be rotated or removed while the host is shutting down.
    }
  }
  }
  const workspacePath = await mkdtemp(join(extensionDevelopmentPath, ".vscode-test-workspace-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "sqlbraid-vscode-user-data-"));
  const extensionsDir = await mkdtemp(join(tmpdir(), "sqlbraid-vscode-extensions-"));
  await cp(fixtureSourcePath, workspacePath, { recursive: true });

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        "--disable-extensions",
        "--disable-gpu",
        "--no-sandbox",
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
      ],
      version: process.env.SQLBRAID_VSCODE_VERSION ?? "1.121.0",
      reuseMachineInstall: true,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    });
  } catch (error) {
    console.error(`VSCode host test failed; dumping logs before cleanup (workspace: ${workspacePath}).`);
    await dumpLogs(join(userDataDir, "logs"));
    throw error;
  } finally {
    await Promise.all([
      rm(workspacePath, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
      rm(extensionsDir, { recursive: true, force: true }),
    ]);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
