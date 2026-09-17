import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { TestProject } from "vitest/node";
import setupMariaDb from "./db/mariadb.global.js";
import setupOracle from "./db/oracle.global.js";

test("external database setup diagnostics do not disclose connection secrets", async () => {
  const secrets = ["sentinel-user", "sentinel-password", "sentinel-token"];
  const output: unknown[][] = [];
  const spies = (["info", "log", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args);
    }),
  );
  vi.stubEnv("SQLBRAID_MARIADB_URL", `mariadb://${secrets[0]}:${secrets[1]}@localhost/test?token=${secrets[2]}`);
  vi.stubEnv("SQLBRAID_ORACLE_URL", `oracle://${secrets[0]}:${secrets[1]}@localhost/test?token=${secrets[2]}`);
  const project = { provide() {} } as TestProject;
  try {
    await (await setupMariaDb(project))();
    await (await setupOracle(project))();
    const logged = JSON.stringify(output);
    for (const secret of secrets) assert.ok(!logged.includes(secret), "Connection secrets must not be logged.");
  } finally {
    for (const spy of spies) spy.mockRestore();
    vi.unstubAllEnvs();
  }
});
