import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { createLanguageService, type LanguageServiceOptions, type SqlBraidLanguageService } from "./index.js";

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
}

interface DocumentState {
  readonly text: string;
  readonly version: number;
}

interface Position {
  readonly line: number;
  readonly character: number;
}

interface LspStreams {
  readonly input: Readable;
  readonly output: Writable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value)) return false;
  return value.id === undefined || typeof value.id === "string" || typeof value.id === "number";
}

function offsetAt(text: string, position: Position): number {
  let line = 0;
  let offset = 0;
  while (line < position.line && offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(text.length, offset + Math.max(0, position.character));
}

function positionAt(text: string, offset: number): Position {
  const safe = Math.max(0, Math.min(offset, text.length));
  const prefix = text.slice(0, safe);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function writeMessage(output: Writable, message: unknown): void {
  const body = JSON.stringify(message);
  output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function uriPath(uri: string): string {
  try { return fileURLToPath(uri); } catch { return uri; }
}

function notification(service: SqlBraidLanguageService, documents: ReadonlyMap<string, DocumentState>, output: Writable, uri: string): void {
  const document = documents.get(uri);
  if (!document) return;
  const diagnostics = service.diagnostics(document.text, uriPath(uri)).map((diagnostic) => ({
    range: { start: positionAt(document.text, diagnostic.range.start), end: positionAt(document.text, diagnostic.range.end) },
    severity: diagnostic.severity === "error" ? 1 : 2,
    code: diagnostic.code,
    source: "sqlbraid",
    message: diagnostic.message,
  }));
  writeMessage(output, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version: document.version, diagnostics } });
}

function parseMessages(buffer: Buffer<ArrayBufferLike>): { readonly messages: readonly JsonRpcMessage[]; readonly rest: Buffer<ArrayBufferLike> } {
  const messages: JsonRpcMessage[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const separator = buffer.indexOf("\r\n\r\n", cursor);
    if (separator < 0) break;
    const headers = buffer.subarray(cursor, separator).toString("ascii");
    const length = /^Content-Length:\s*(\d+)$/im.exec(headers)?.[1];
    if (!length) { cursor = separator + 4; continue; }
    const bodyStart = separator + 4;
    const bodyEnd = bodyStart + Number(length);
    if (bodyEnd > buffer.length) break;
    try {
      const message: unknown = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      if (isJsonRpcMessage(message)) messages.push(message);
    } catch { /* malformed JSON is ignored */ }
    cursor = bodyEnd;
  }
  return { messages, rest: buffer.subarray(cursor) };
}

function documentParams(params: unknown): { readonly uri: string; readonly text?: string; readonly version?: number } | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument) || typeof params.textDocument.uri !== "string") return undefined;
  return { uri: params.textDocument.uri, ...(typeof params.textDocument.text === "string" ? { text: params.textDocument.text } : {}), ...(typeof params.textDocument.version === "number" ? { version: params.textDocument.version } : {}) };
}

function positionParams(params: unknown): { readonly uri: string; readonly position: Position } | undefined {
  if (!isRecord(params) || !isRecord(params.textDocument) || !isRecord(params.position) || typeof params.textDocument.uri !== "string" || typeof params.position.line !== "number" || typeof params.position.character !== "number") return undefined;
  return { uri: params.textDocument.uri, position: { line: params.position.line, character: params.position.character } };
}

export function startStdioLanguageServer(options: LanguageServiceOptions, streams: LspStreams = { input: process.stdin, output: process.stdout }): () => void {
  const service = createLanguageService(options);
  const documents = new Map<string, DocumentState>();
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stopped = false;
  const handle = async (message: JsonRpcMessage): Promise<void> => {
    const method = message.method;
    if (!method) return;
    if (method === "initialize") {
      if (message.id !== undefined) writeMessage(streams.output, { jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true, completionProvider: { triggerCharacters: ["."] }, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } } });
      return;
    }
    if (method === "shutdown") {
      if (message.id !== undefined) writeMessage(streams.output, { jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (method === "exit") { stopped = true; streams.input.off("data", onData); return; }
    if (method === "textDocument/didOpen") {
      const item = documentParams(message.params);
      if (!item || item.text === undefined) return;
      documents.set(item.uri, { text: item.text, version: item.version ?? 0 });
      notification(service, documents, streams.output, item.uri);
      return;
    }
    if (method === "textDocument/didChange") {
      const item = documentParams(message.params);
      const params = isRecord(message.params) ? message.params : undefined;
      const changes = params?.contentChanges;
      const current = item ? documents.get(item.uri) : undefined;
      const last = Array.isArray(changes) ? changes.at(-1) : undefined;
      if (item && current && isRecord(last) && typeof last.text === "string") documents.set(item.uri, { text: last.text, version: item.version ?? current.version + 1 });
      if (item) notification(service, documents, streams.output, item.uri);
      return;
    }
    if (method === "textDocument/didClose") {
      const item = documentParams(message.params);
      if (!item) return;
      documents.delete(item.uri);
      writeMessage(streams.output, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: item.uri, diagnostics: [] } });
      return;
    }
    if (method === "textDocument/diagnostic") {
      const item = documentParams(message.params);
      const document = item ? documents.get(item.uri) : undefined;
      const diagnostics = document ? service.diagnostics(document.text, uriPath(item?.uri ?? "")).map((diagnostic) => ({ range: { start: positionAt(document.text, diagnostic.range.start), end: positionAt(document.text, diagnostic.range.end) }, severity: diagnostic.severity === "error" ? 1 : 2, code: diagnostic.code, source: "sqlbraid", message: diagnostic.message })) : [];
      if (message.id !== undefined) writeMessage(streams.output, { jsonrpc: "2.0", id: message.id, result: { kind: "full", items: diagnostics } });
      return;
    }
    if (method === "textDocument/hover") {
      const item = positionParams(message.params);
      const document = item ? documents.get(item.uri) : undefined;
      const hover = document && item ? service.hover(document.text, uriPath(item.uri), offsetAt(document.text, item.position)) : undefined;
      if (message.id !== undefined) writeMessage(streams.output, { jsonrpc: "2.0", id: message.id, result: hover && document ? { contents: { kind: "markdown", value: hover.contents }, range: { start: positionAt(document.text, hover.range.start), end: positionAt(document.text, hover.range.end) } } : null });
      return;
    }
    if (method === "textDocument/completion") {
      const item = positionParams(message.params);
      const document = item ? documents.get(item.uri) : undefined;
      const prefix = document && item ? document.text.slice(0, offsetAt(document.text, item.position)).split(/\s|\./u).at(-1) ?? "" : "";
      const items = service.complete(prefix).map((entry) => ({ label: entry.label, kind: entry.kind === "column" ? 5 : entry.kind === "relation" ? 7 : 3, detail: entry.detail }));
      if (message.id !== undefined) writeMessage(streams.output, { jsonrpc: "2.0", id: message.id, result: { isIncomplete: false, items } });
    }
  };
  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    const parsed = parseMessages(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) void handle(message);
  };
  streams.input.on("data", onData);
  return () => { stopped = true; streams.input.off("data", onData); };
}

