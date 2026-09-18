#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const packageDir = resolve(process.env.SQLBRAID_PACK_INPUT_DIR ?? join(root, ".compatibility-packages"));
const consumer = mkdtempSync(join(tmpdir(), "sqlbraid-lsp-consumer-"));
const tarballs = new Map();
for (const file of readdirSync(packageDir))
  if (file.endsWith(".tgz")) {
    const path = join(packageDir, file);
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
    tarballs.set(manifest.name, `file:${path}`);
  }
for (const name of [
  "@sqlbraid/language-server",
  "@sqlbraid/compiler",
  "@sqlbraid/core",
  "@sqlbraid/metadata",
  "@sqlbraid/tooling",
]) {
  if (!tarballs.has(name)) throw new Error(`Missing candidate tarball: ${name}`);
}
const overrides = Object.fromEntries(
  [...tarballs.entries()].filter(([name]) => name.startsWith("@sqlbraid/") || name === "sqlbraid"),
);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "sqlbraid-isolated-lsp-consumer",
      private: true,
      type: "module",
      dependencies: { "@sqlbraid/language-server": tarballs.get("@sqlbraid/language-server") },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(consumer, "pnpm-workspace.yaml"),
  `packages: []\noverrides:\n${Object.entries(overrides)
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    .join("\n")}\n`,
);
writeFileSync(join(consumer, ".npmrc"), "node-linker=isolated\nshamefully-hoist=false\npublic-hoist-pattern[]=\n");
execFileSync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: consumer, stdio: "inherit" });
const server = spawn(process.execPath, [join(consumer, "node_modules/@sqlbraid/language-server/dist/cli.js")], {
  cwd: consumer,
  stdio: "pipe",
});
let buffer = Buffer.alloc(0);
const messages = [];
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) break;
    const header = buffer.subarray(0, separator).toString("ascii");
    const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
    if (!length || buffer.length < separator + 4 + Number(length)) break;
    const start = separator + 4;
    messages.push(JSON.parse(buffer.subarray(start, start + Number(length)).toString("utf8")));
    buffer = buffer.subarray(start + Number(length));
  }
});
const waitFor = async (id) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id);
    if (found) return found;
    // eslint-disable-next-line no-await-in-loop -- Poll the asynchronously filled response queue without busy-waiting.
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for isolated LSP response ${id}`);
};
const send = (message) => {
  const body = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: process.pid, rootUri: null, capabilities: {} },
  });
  const initialized = await waitFor(1);
  assert.equal(initialized.result?.capabilities?.hoverProvider, true);
  send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
  assert.equal((await waitFor(2)).result, null);
  send({ jsonrpc: "2.0", method: "exit", params: null });
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Isolated LSP server did not exit")), 10000);
    server.once("close", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  console.info(`PASS isolated language-server package consumer: ${consumer}`);
} finally {
  if (!server.killed) server.kill();
}
