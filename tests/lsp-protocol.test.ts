import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { generateModels } from "@sqlbraid/codegen";
import type { MetadataSnapshot } from "@sqlbraid/metadata";

type JsonRpcMessage = { readonly id?: number | string; readonly method?: string; readonly result?: unknown; readonly params?: unknown };
type Position = { readonly line: number; readonly character: number };

type MessageReader = {
  readonly next: (match: (message: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage>;
  readonly dispose: () => void;
};

function createMessageReader(process: ChildProcessWithoutNullStreams): MessageReader {
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const messages: JsonRpcMessage[] = [];
  const waiters: Array<{ readonly match: (message: JsonRpcMessage) => boolean; readonly resolve: (message: JsonRpcMessage) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }> = [];
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = buffer.subarray(0, separator).toString("ascii");
      const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1];
      if (!length) {
        buffer = buffer.subarray(separator + 4);
        continue;
      }
      const bodyStart = separator + 4;
      const bodyEnd = bodyStart + Number(length);
      if (bodyEnd > buffer.length) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      let message: JsonRpcMessage;
      try { message = JSON.parse(body) as JsonRpcMessage; } catch { continue; }
      const waiter = waiters.find((candidate) => candidate.match(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else messages.push(message);
    }
  };
  const failPending = (reason: string): void => {
    const error = new Error(`${reason}${stderr ? `\n${stderr}` : ""}`);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const onStderr = (chunk: Buffer): void => { stderr += chunk.toString("utf8"); };
  const onError = (error: Error): void => { failPending(`LSP process error: ${error.message}`); };
  const onClose = (code: number | null): void => { failPending(`LSP process closed before the response (code ${code ?? "unknown"}).`); };
  process.stdout.on("data", onData);
  process.stderr.on("data", onStderr);
  process.once("error", onError);
  process.once("close", onClose);
  return {
    next(match, timeoutMs = 10000) {
      const existing = messages.find((message) => match(message));
      if (existing) {
        messages.splice(messages.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      const { promise, resolve: resolveMessage, reject } = Promise.withResolvers<JsonRpcMessage>();
      // Real child-process protocol I/O needs a bounded wall-clock guard.
      const timer = setTimeout(() => {
        const waiter = waiters.find((candidate) => candidate.timer === timer);
        if (waiter) waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for LSP message after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ match, resolve: resolveMessage, reject, timer });
      return promise;
    },
    dispose() {
      process.stdout.off("data", onData);
      process.stderr.off("data", onStderr);
      process.off("error", onError);
      process.off("close", onClose);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("LSP message reader disposed"));
      }
    },
  };
}

function send(process: ChildProcessWithoutNullStreams, message: object): void {
  const body = JSON.stringify(message);
  process.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function response(reader: MessageReader, id: number): Promise<JsonRpcMessage> {
  return reader.next((message) => message.id === id);
}

function resultOf<T>(message: JsonRpcMessage): T {
  return message.result as T;
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs = 10000): Promise<void> {
  const { promise, resolve: resolveExit, reject: rejectExit } = Promise.withResolvers<void>();
  // Real child-process shutdown needs a bounded wall-clock guard.
  const timer = setTimeout(() => rejectExit(new Error("LSP server did not exit")), timeoutMs);
  process.once("close", () => { clearTimeout(timer); resolveExit(); });
  return promise;
}

test("built stdio server speaks standard LSP methods", async () => {
  const server = spawn(process.execPath, [resolve("packages/language-server/dist/cli.js")], { stdio: "pipe" });
  const reader = createMessageReader(server);
  const uri = pathToFileURL(resolve("tests/sqlbraid lsp fixture.ts")).href;
  const source = [
    "import { sql } from '@sqlbraid/template';",
    "type UserRow = { id: bigint };",
    "const ordinaryObject = { id: 1 };",
    "const query = sql.rows<UserRow>`SELECT id FROM users`;",
  ].join("\n");
  try {
    send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(resolve("tests")).href,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(resolve("tests")).href, name: "tests" }],
      },
    });
    const initialized = resultOf<{ capabilities: Record<string, unknown> }>(await response(reader, 1));
    assert.equal(initialized.capabilities.hoverProvider, true);
    assert.equal(initialized.capabilities.completionProvider !== undefined, true);
    assert.equal(initialized.capabilities.definitionProvider, true);
    assert.equal(initialized.capabilities.referencesProvider, true);
    assert.equal(initialized.capabilities.documentSymbolProvider, true);
    assert.equal(initialized.capabilities.workspaceSymbolProvider, true);
    assert.equal(initialized.capabilities.signatureHelpProvider !== undefined, true);
    assert.equal(initialized.capabilities.diagnosticProvider !== undefined, true);
    send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
    send(server, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: source } } });
    const published = await reader.next((message) => message.method === "textDocument/publishDiagnostics");
    assert.equal((published.params as { readonly version?: number }).version, 1);

    const selectOffset = source.indexOf("SELECT");
    send(server, { jsonrpc: "2.0", id: 2, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
    assert.equal(resultOf<{ readonly items: readonly unknown[] }>(await response(reader, 2)).items.length, 0);
    send(server, { jsonrpc: "2.0", id: 3, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 3, character: selectOffset - source.lastIndexOf("\n", selectOffset) - 1 } } });
    assert.match(JSON.stringify(resultOf<unknown>(await response(reader, 3))), /RowQuery<UserRow>/u);
    send(server, { jsonrpc: "2.0", id: 4, method: "textDocument/completion", params: { textDocument: { uri }, position: { line: 2, character: source.split("\n")[2].length } } });
    assert.deepEqual(resultOf<{ readonly items: readonly unknown[] }>(await response(reader, 4)).items, []);
    send(server, { jsonrpc: "2.0", id: 5, method: "textDocument/definition", params: { textDocument: { uri }, position: { line: 3, character: 53 } } });
    assert.equal(resultOf<unknown>(await response(reader, 5)), null);
    send(server, { jsonrpc: "2.0", id: 6, method: "textDocument/references", params: { textDocument: { uri }, position: { line: 3, character: 53 }, context: { includeDeclaration: true } } });
    assert.deepEqual(resultOf<readonly unknown[]>(await response(reader, 6)), []);
    send(server, { jsonrpc: "2.0", id: 7, method: "textDocument/documentSymbol", params: { textDocument: { uri } } });
    assert.equal((resultOf<readonly unknown[]>(await response(reader, 7))).length, 1);
    send(server, { jsonrpc: "2.0", id: 8, method: "workspace/symbol", params: { query: "does-not-exist" } });
    assert.deepEqual(resultOf<readonly unknown[]>(await response(reader, 8)), []);
    send(server, { jsonrpc: "2.0", id: 9, method: "textDocument/signatureHelp", params: { textDocument: { uri }, position: { line: 3, character: 53 } } });
    assert.deepEqual(resultOf<unknown>(await response(reader, 9)), null);

    const staleRequest = 12;
    const broken = `${source}\nconst broken = sql.rows<UserRow>\`SELECT /*@braid if */ id\`;`;
    send(server, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] } });
    send(server, { jsonrpc: "2.0", id: staleRequest, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
    send(server, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: staleRequest } });
    send(server, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: source }] } });
    const latestPublished = await reader.next((message) => message.method === "textDocument/publishDiagnostics" && (message.params as { readonly version?: number }).version === 3);
    assert.equal((latestPublished.params as { readonly version?: number }).version, 3);

    const mixed = `${source}\nconst native: string = 123;\nconst malformed = sql\`SELECT 1 /*@braid otherwise*/\`;`;
    send(server, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 4 }, contentChanges: [{ text: mixed }] } });
    send(server, { jsonrpc: "2.0", id: 13, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
    const mixedDiagnostics = resultOf<{ readonly items: readonly { readonly code?: string }[] }>(await response(reader, 13)).items;
    assert.equal(mixedDiagnostics.some((diagnostic) => diagnostic.code === "BRAID_STRUCTURE"), true);
    assert.equal(mixedDiagnostics.some((diagnostic) => diagnostic.code === "TS2322"), false);
    send(server, { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 5 }, contentChanges: [{ text: source }] } });
    await reader.next((message) => message.method === "textDocument/publishDiagnostics" && (message.params as { readonly version?: number }).version === 5);

    send(server, { jsonrpc: "2.0", id: 10, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 3, character: selectOffset } } });
    send(server, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 10 } });
    send(server, { jsonrpc: "2.0", id: 11, method: "shutdown", params: null });
    assert.equal(resultOf<unknown>(await response(reader, 11)), null);
    send(server, { jsonrpc: "2.0", method: "exit", params: null });
    await waitForExit(server);
  } finally {
    reader.dispose();
    if (!server.killed) server.kill();
  }
}, 30000);

test("built stdio server discovers facade metadata with default configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlbraid-lsp-facade-"));
  const metadataPath = join(root, "metadata.json");
  const configPath = join(root, "sqlbraid.config.mjs");
  const sourcePath = join(root, "query.ts");
  const uri = pathToFileURL(sourcePath).href;
  const source = [
    'import { sql } from "sqlbraid/sqlite";',
    'type UserRow = { id: number };',
    'export const query = sql.rows<UserRow>`SELECT calculate_fee(1) AS id FROM main.users`;',
  ].join("\n");
  const snapshot = {
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect: "sqlite",
    dialectVersion: "3",
    server: {},
    namespaces: { main: { name: "main", kind: "attached" } },
    types: {},
    relations: {
      "main.users": {
        identity: "main.users",
        name: "users",
        namespace: "main",
        kind: "table",
        columns: [{ name: "id", ordinal: 0, type: "INTEGER", nullable: false }],
      },
    },
    routines: {
      "main.calculate_fee": [{
        name: "calculate_fee",
        schema: "main",
        identity: "main.calculate_fee",
        kind: "function",
        arguments: [{ name: "amount", mode: "in", type: "INTEGER" }],
        argumentsComplete: true,
        result: { kind: "scalar", type: "INTEGER", nullable: false },
      }],
    },
    metadata: { introspectionScope: "main", completeness: "partial" },
  };
  const config = {
    codegen: {
      targets: [{
        name: "sqlite",
        metadata: "./metadata.json",
        outFile: "./generated.ts",
        typePolicy: {
          id: "sqlite-lsp-test",
          hash: "sqlite-lsp-test-v1",
          mappings: [{ databaseType: "INTEGER", inputType: "number", outputType: "number", nullable: false }],
        },
      }],
    },
  };
  const positionAt = (offset: number): Position => {
    const before = source.slice(0, offset);
    return { line: before.split("\n").length - 1, character: offset - before.lastIndexOf("\n") - 1 };
  };
  await writeFile(metadataPath, JSON.stringify(snapshot));
  await writeFile(configPath, `export default ${JSON.stringify(config)};\n`);
  await writeFile(sourcePath, source);
  const server = spawn(process.execPath, [resolve("packages/language-server/dist/cli.js")], { stdio: "pipe" });
  const reader = createMessageReader(server);
  try {
    send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: "facade" }],
      },
    });
    await response(reader, 1);
    send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
    send(server, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: source } } });
    await reader.next((message) => message.method === "textDocument/publishDiagnostics");

    const relationOffset = source.indexOf("main.users") + "main.".length;
    send(server, { jsonrpc: "2.0", id: 2, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
    assert.deepEqual(resultOf<{ readonly items: readonly unknown[] }>(await response(reader, 2)).items, []);
    send(server, { jsonrpc: "2.0", id: 3, method: "textDocument/completion", params: { textDocument: { uri }, position: positionAt(relationOffset) } });
    assert.deepEqual(resultOf<{ readonly items: readonly { readonly label: string }[] }>(await response(reader, 3)).items.map((item) => item.label), ["users"]);
    send(server, { jsonrpc: "2.0", id: 4, method: "textDocument/hover", params: { textDocument: { uri }, position: positionAt(relationOffset) } });
    assert.match(JSON.stringify(resultOf<unknown>(await response(reader, 4))), /Relation main\.users/u);
    send(server, { jsonrpc: "2.0", id: 5, method: "textDocument/definition", params: { textDocument: { uri }, position: positionAt(relationOffset) } });
    assert.match(JSON.stringify(resultOf<unknown>(await response(reader, 5))), /metadata\.json/u);
    send(server, { jsonrpc: "2.0", id: 6, method: "textDocument/references", params: { textDocument: { uri }, position: positionAt(relationOffset), context: { includeDeclaration: true } } });
    assert.ok(resultOf<readonly unknown[]>(await response(reader, 6)).length >= 1);
    send(server, { jsonrpc: "2.0", id: 7, method: "textDocument/documentSymbol", params: { textDocument: { uri } } });
    assert.deepEqual((resultOf<readonly { readonly name: string }[]>(await response(reader, 7))).map((symbol) => symbol.name), ["sql.rows"]);
    send(server, { jsonrpc: "2.0", id: 8, method: "workspace/symbol", params: { query: "users" } });
    assert.deepEqual((resultOf<readonly { readonly name: string; readonly kind: number }[]>(await response(reader, 8))).map((symbol) => [symbol.name, symbol.kind]), [["users", 5]]);
    const signatureOffset = source.indexOf("calculate_fee(") + "calculate_fee(".length;
    send(server, { jsonrpc: "2.0", id: 9, method: "textDocument/signatureHelp", params: { textDocument: { uri }, position: positionAt(signatureOffset) } });
    const signature = resultOf<{ readonly signatures: readonly { readonly parameters: readonly { readonly label: string }[] }[] }>(await response(reader, 9));
    assert.deepEqual(signature.signatures[0]?.parameters.map((parameter) => parameter.label), ["amount: INTEGER"]);

    send(server, { jsonrpc: "2.0", id: 10, method: "shutdown", params: null });
    assert.equal(resultOf<unknown>(await response(reader, 10)), null);
    send(server, { jsonrpc: "2.0", method: "exit", params: null });
    await waitForExit(server);
  } finally {
    reader.dispose();
    if (!server.killed) server.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("built stdio server routes workspace symbols across multiple roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlbraid-lsp-"));
  const alphaRoot = join(root, "alpha");
  const betaRoot = join(root, "beta");
  await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
  const snapshot = (name: string): MetadataSnapshot => ({
    format: "sqlbraid-metadata",
    formatVersion: 1,
    dialect: "postgres",
    dialectVersion: "16",
    server: {},
    namespaces: {},
    types: {},
    relations: {
      [`public.${name}`]: {
        identity: `public.${name}`,
        name,
        namespace: "public",
        kind: "table",
        columns: [{ name: "id", ordinal: 1, type: "int8", nullable: false }],
      },
    },
    routines: {},
    metadata: {},
  });
  const testTypePolicy = {
    id: "test",
    hash: "test",
    mappings: [{ databaseType: "int8", inputType: "bigint", outputType: "bigint", nullable: false }],
    decode: (_databaseType: string, value: unknown) => value,
    encode: (_databaseType: string, value: unknown) => value,
  };
  const config = {
    codegen: {
      targets: [{
        name: "database",
        metadata: "metadata.json",
        outFile: "generated.ts",
        typePolicy: {
          id: testTypePolicy.id,
          hash: testTypePolicy.hash,
          mappings: testTypePolicy.mappings,
        },
      }],
    },
  };
  await Promise.all([alphaRoot, betaRoot].flatMap((projectRoot, index) => {
    const metadata = snapshot(index === 0 ? "alpha_users" : "beta_users");
    const generated = generateModels(metadata, { typePolicy: testTypePolicy });
    return [
      writeFile(join(projectRoot, "metadata.json"), JSON.stringify(metadata)),
      writeFile(join(projectRoot, "generated.ts"), generated.source),
      writeFile(join(projectRoot, "sqlbraid.config.mjs"), `export default ${JSON.stringify(config)};`),
    ];
  }));
  const server = spawn(process.execPath, [resolve("packages/language-server/dist/cli.js")], { stdio: "pipe" });
  const reader = createMessageReader(server);
  try {
    send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(alphaRoot).href,
        capabilities: {},
        workspaceFolders: [
          { uri: pathToFileURL(alphaRoot).href, name: "alpha" },
          { uri: pathToFileURL(betaRoot).href, name: "beta" },
        ],
      },
    });
    await response(reader, 1);
    send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
    send(server, { jsonrpc: "2.0", id: 2, method: "workspace/symbol", params: { query: "alpha_users" } });
    const alpha = resultOf<readonly { readonly name: string }[]>(await response(reader, 2));
    assert.deepEqual(alpha.map((symbol) => symbol.name), ["alpha_users"]);
    send(server, { jsonrpc: "2.0", id: 3, method: "workspace/symbol", params: { query: "beta_users" } });
    const beta = resultOf<readonly { readonly name: string }[]>(await response(reader, 3));
    assert.deepEqual(beta.map((symbol) => symbol.name), ["beta_users"]);
    send(server, { jsonrpc: "2.0", id: 4, method: "shutdown", params: null });
    await response(reader, 4);
    send(server, { jsonrpc: "2.0", method: "exit", params: null });
    await waitForExit(server);
  } finally {
    reader.dispose();
    if (!server.killed) server.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("stdio server registers only relevant project file watchers", async () => {
  const server = spawn(process.execPath, [resolve("packages/language-server/dist/cli.js")], { stdio: "pipe" });
  const reader = createMessageReader(server);
  try {
    send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(resolve("tests")).href,
        capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
        workspaceFolders: [{ uri: pathToFileURL(resolve("tests")).href, name: "tests" }],
      },
    });
    await response(reader, 1);
    send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
    const registration = await reader.next((message) => message.method === "client/registerCapability");
    const registrations = (registration.params as { readonly registrations: readonly { readonly registerOptions?: { readonly watchers?: readonly { readonly globPattern: string }[] } }[] }).registrations;
    const watchers = registrations.flatMap((entry) => entry.registerOptions?.watchers ?? []).map((watcher) => watcher.globPattern);
    assert.deepEqual(watchers, [
      "**/sqlbraid.config.mjs",
      "**/sqlbraid.config.js",
      "**/sqlbraid.config.cjs",
      "**/tsconfig*.json",
      "**/package.json",
      "**/*.{ts,tsx,mts,cts,js,jsx}",
    ]);
    send(server, { jsonrpc: "2.0", id: registration.id, result: null });
    send(server, { jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
    await response(reader, 2);
    send(server, { jsonrpc: "2.0", method: "exit", params: null });
    await waitForExit(server);
  } finally {
    reader.dispose();
    if (!server.killed) server.kill();
  }
}, 30000);

test("real LSP diagnostics preserve native, Braid, and overlay-only ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlbraid-lsp-diagnostics-"));
  const modulePath = join(root, "tag.ts");
  await writeFile(modulePath, "export declare const sql: any;\n");
  const sourcePath = join(root, "fixture.ts");
  const source = [
    `import { sql } from ${JSON.stringify(modulePath)};`,
    "const native: string = 123;",
    "const malformed = sql`SELECT 1 /*@braid otherwise*/`;",
    "const lowered = sql`SELECT 1 /*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;",
  ].join("\n");
  const serverModule = pathToFileURL(resolve("packages/language-server/dist/server.js")).href;
  const bootstrap = `import { startStdioLanguageServer } from ${JSON.stringify(serverModule)}; startStdioLanguageServer({ moduleSpecifier: ${JSON.stringify(modulePath)} });`;
  const server = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], { stdio: "pipe" });
  const reader = createMessageReader(server);
  const uri = pathToFileURL(sourcePath).href;
  try {
    send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(root).href, name: "diagnostics" }] },
    });
    await response(reader, 1);
    send(server, { jsonrpc: "2.0", method: "initialized", params: {} });
    send(server, { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: source } } });
    const published = await reader.next((message) => message.method === "textDocument/publishDiagnostics");
    const diagnostics = (published.params as { readonly diagnostics: readonly { readonly code?: string }[] }).diagnostics;
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "BRAID_STRUCTURE"), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "TS2307"), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "TS7006"), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "TS2322"), false);
    send(server, { jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
    await response(reader, 2);
    send(server, { jsonrpc: "2.0", method: "exit", params: null });
    await waitForExit(server);
  } finally {
    reader.dispose();
    if (!server.killed) server.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
