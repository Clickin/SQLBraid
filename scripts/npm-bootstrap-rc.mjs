#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));
const child = spawn(process.execPath, [releaseScript, "--mode", "bootstrap", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
