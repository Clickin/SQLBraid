import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const execFileAsync = promisify(execFile);

async function readLogs(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const logs = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readLogs(path);
      return entry.name.endsWith(".log") ? readFile(path, "utf8").catch(() => "") : "";
    }),
  );
  return logs.join("\n");
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "sqlbraid-vscode-host-"));
  const sourceExtension = resolve(__dirname, "../..");
  const extensionTestsPath = resolve(__dirname, "./suite/index.js");
  const executable =
    process.env.SQLBRAID_VSCODE_EXECUTABLE ??
    (await downloadAndUnzipVSCode(process.env.SQLBRAID_VSCODE_VERSION ?? "1.121.0"));
  const extensionsDir = join(temporary, "extensions");
  let extensionPath = sourceExtension;
  let extensionDevelopmentPath = sourceExtension;
  let workspacePath: string | undefined;
  try {
    await mkdir(extensionsDir);
    if (process.env.SQLBRAID_VSIX_PATH) {
      const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
      const installed = await execFileAsync(
        cli,
        [
          ...args,
          "--install-extension",
          process.env.SQLBRAID_VSIX_PATH,
          "--force",
          "--extensions-dir",
          extensionsDir,
          "--user-data-dir",
          join(temporary, "install-profile"),
          "--no-sandbox",
        ],
        { shell: process.platform === "win32" },
      );
      process.stdout.write(installed.stdout);
      const directory = (await readdir(extensionsDir)).find((name) => name.startsWith("sqlbraid.sqlbraid-vscode-"));
      assert.ok(directory, "VS Code CLI must install the packaged extension into the clean profile.");
      extensionPath = join(extensionsDir, directory);
      extensionDevelopmentPath = join(temporary, "test-harness");
      await mkdir(extensionDevelopmentPath);
      await writeFile(
        join(extensionDevelopmentPath, "package.json"),
        JSON.stringify({
          name: "sqlbraid-host-tests",
          publisher: "sqlbraid-tests",
          version: "0.0.0",
          engines: { vscode: "*" },
        }),
      );
    }
    // The fixture inherits only the tested extension's installed dependencies.
    workspacePath = await mkdtemp(join(extensionPath, ".vscode-test-workspace-"));
    await cp(resolve(__dirname, "../../test/fixture"), workspacePath, { recursive: true });
    const unrelated = join(temporary, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "package.json"), JSON.stringify({ name: "unrelated", private: true }));
    await writeFile(
      join(unrelated, "plain.ts"),
      "const nativeObject = { nativeField: 1 };\nnativeObject.nativeField;\n",
    );
    for (const scenario of ["project", "unrelated"] as const) {
      const userDataDir = join(temporary, `${scenario}-profile`);
      try {
        await runTests({
          extensionDevelopmentPath,
          extensionTestsPath,
          vscodeExecutablePath: executable,
          reuseMachineInstall: true,
          launchArgs: [
            scenario === "project" ? workspacePath : unrelated,
            "--disable-gpu",
            "--no-sandbox",
            "--user-data-dir",
            userDataDir,
            "--extensions-dir",
            extensionsDir,
          ],
          extensionTestsEnv: {
            SQLBRAID_VSCODE_SCENARIO: scenario,
            SQLBRAID_EXPECT_EXTENSION_PATH: extensionPath,
            SQLBRAID_OUTSIDE_PATH: join(temporary, "outside"),
          },
        });
        const logs = await readLogs(join(userDataDir, "logs"));
        assert.equal(
          logs.includes("Started SQLBraid"),
          scenario === "project",
          `SQLBraid physical server startup must match ${scenario} project evidence.`,
        );
        console.info(`PASS VS Code ${scenario} host (${process.env.SQLBRAID_VSIX_PATH ? "installed VSIX" : "source"})`);
      } catch (error) {
        console.error((await readLogs(join(userDataDir, "logs"))).slice(-40_000));
        throw error;
      }
    }
  } finally {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
