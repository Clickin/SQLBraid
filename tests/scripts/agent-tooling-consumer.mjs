import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspace } from "@sqlbraid/tooling";
import { createLanguageService } from "@sqlbraid/language-server";
import { defineConfig } from "@sqlbraid/cli/config";
import { generateModels } from "@sqlbraid/codegen";
import "@sqlbraid/cli";

const metadata = {
  format: "sqlbraid-metadata",
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: "16",
  server: {},
  namespaces: {},
  types: {},
  relations: {
    "public.users": {
      identity: "public.users",
      name: "users",
      namespace: "public",
      kind: "table",
      columns: [{ name: "id", ordinal: 1, type: "int4", nullable: false }],
    },
  },
  routines: {
    "public.calculate_fee": [
      {
        identity: "public.calculate_fee",
        name: "calculate_fee",
        schema: "public",
        kind: "function",
        arguments: [],
        argumentsComplete: false,
        result: { kind: "scalar", type: "numeric" },
      },
    ],
  },
  metadata: { completeness: "partial", introspectionScope: "public" },
};
const typePolicy = {
  id: "agent-consumer",
  hash: "agent-consumer-v1",
  mappings: [{ databaseType: "int4", inputType: "number", outputType: "number", nullable: false }],
};
const config = defineConfig({
  codegen: { targets: [{ name: "db", metadata: "agent-metadata.json", outFile: "agent-models.ts", typePolicy }] },
});
await writeFile("agent-metadata.json", JSON.stringify(metadata, null, 2));
await writeFile("sqlbraid.config.mjs", `export default ${JSON.stringify(config)};\n`);
await writeFile("agent-models.ts", generateModels(metadata, { typePolicy }).source);
const source =
  'import { sql } from "@sqlbraid/template";\nconst query = sql.rows<{id:number}>`SELECT public.users.id FROM public.users`;\n';
const fileName = resolve("agent-query.ts");
await writeFile(fileName, source);
await writeFile(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      skipLibCheck: true,
    },
    files: ["agent-query.ts"],
  }),
);
const workspace = createWorkspace({ rootPath: process.cwd() });
const workspaceStart = performance.now();
const service = await workspace.service();
const workspaceLoadMs = performance.now() - workspaceStart;
const offset = source.lastIndexOf("users") + 2;
const coldStart = performance.now();
const hover = service.hover(source, fileName, offset);
const coldMs = performance.now() - coldStart;
assert.match(hover?.contents ?? "", /UsersRow/);
const definition = service.definition(source, fileName, offset);
assert.equal(definition?.uri, pathToFileURL(resolve("agent-models.ts")).href);
assert.ok(service.workspaceSymbols("UsersRow").some((item) => item.name === "UsersRow"));
assert.deepEqual(createLanguageService({ metadata }).complete("const ordinary = {}; ordinary.", "ordinary.ts", 30), []);
const repeatedStart = performance.now();
for (let index = 0; index < 100; index += 1) service.hover(source, fileName, offset);
const repeated100Ms = performance.now() - repeatedStart;
const reuseStart = performance.now();
await workspace.service();
const workspaceReuseMs = performance.now() - reuseStart;
console.info(
  JSON.stringify({
    check: "packed tooling evidence",
    workspaceLoadMs,
    workspaceReuseMs,
    coldMs,
    repeated100Ms,
    definition,
  }),
);
workspace.dispose();

const line = source.slice(0, offset).split("\n").length - 1;
const character = offset - source.lastIndexOf("\n", offset - 1) - 1;
const cli = resolve("node_modules/@sqlbraid/cli/dist/index.js");
const inspect = (...args) =>
  JSON.parse(execFileSync(process.execPath, [cli, "inspect", ...args, "--json"], { encoding: "utf8" }));
const inspected = inspect("query", "--file", fileName, "--line", String(line + 1), "--column", String(character + 1));
assert.equal(inspected.resolved, true);
assert.match(inspected.contents, /UsersRow/);
assert.match(JSON.stringify(inspect("symbol", "UsersRow")), /agent-models\.ts/);
assert.deepEqual(inspect("diagnostics", "--file", fileName).diagnostics, []);
console.info("PASS packed CLI inspection: query, symbol, structured diagnostics");

// Wire framing belongs to this external client, never the server implementation.
const child = spawn(process.execPath, [resolve("node_modules/@sqlbraid/language-server/dist/cli.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = Buffer.alloc(0);
let sequence = 0;
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, end).toString())?.[1]);
    assert.ok(Number.isFinite(length));
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry) message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  }
});
function send(method, params, id) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 30_000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolveResult(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send(method, params, id);
  });
}
try {
  const initialize = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(process.cwd()).href,
    capabilities: { textDocument: { diagnostic: {} }, workspace: { workspaceFolders: true } },
  });
  for (const capability of [
    "hoverProvider",
    "definitionProvider",
    "referencesProvider",
    "documentSymbolProvider",
    "workspaceSymbolProvider",
    "completionProvider",
    "diagnosticProvider",
  ])
    assert.ok(initialize.capabilities[capability], capability);
  send("initialized", {});
  const uri = pathToFileURL(fileName).href;
  send("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: source } });
  const params = { textDocument: { uri }, position: { line, character } };
  assert.match(JSON.stringify(await request("textDocument/hover", params)), /UsersRow/);
  assert.match(JSON.stringify(await request("textDocument/definition", params)), /agent-models\.ts/);
  assert.ok((await request("textDocument/documentSymbol", { textDocument: { uri } })).length > 0);
  assert.match(JSON.stringify(await request("workspace/symbol", { query: "UsersRow" })), /UsersRow/);
  assert.deepEqual((await request("textDocument/diagnostic", { textDocument: { uri } })).items, []);
  await request("shutdown", null);
  const exited = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not exit")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveExit() : reject(new Error(`Server exit ${code}: ${stderr}`));
    });
  });
  send("exit", null);
  await exited;
  console.info(
    "PASS packed standard LSP: initialize, diagnostics, hover, definition, document/workspace symbols, shutdown/exit",
  );
} finally {
  child.kill();
  for (const entry of pending.values()) entry.reject(new Error("Client closed"));
}
// Generated navigation was tested against the bytes actually installed on disk.
assert.equal(await readFile("agent-models.ts", "utf8"), generateModels(metadata, { typePolicy }).source);
