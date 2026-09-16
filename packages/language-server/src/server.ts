import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  MarkupKind,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type CancellationToken,
  type Disposable,
  type InitializeParams,
  type WorkspaceFoldersChangeEvent,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { CompileDiagnostic } from "@sqlbraid/compiler";
import { AUTHORING_MODULE_CATALOG } from "@sqlbraid/core";
import {
  createWorkspace,
  type Cancellation,
  type LanguageServiceOptions,
  type SqlBraidLanguageService,
  type ToolingWorkspace,
  type WorkspaceSymbol,
} from "@sqlbraid/tooling";

export interface LspStreams {
  readonly input: Readable;
  readonly output: Writable;
}

export interface StdioLanguageServerOptions extends LanguageServiceOptions {
  readonly configPath?: string;
}

type Position = { readonly line: number; readonly character: number };
type Range = { readonly start: Position; readonly end: Position };

type PendingDiagnostics = {
  readonly version: number;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ActiveDiagnostics = {
  readonly version: number;
  readonly cancel: () => void;
};

type WorkspaceSlot = {
  readonly rootPath: string;
  readonly workspace: ToolingWorkspace;
};

const DEFAULT_MODULE_SPECIFIERS = AUTHORING_MODULE_CATALOG.map(({ moduleSpecifier }) => moduleSpecifier);
const DIAGNOSTIC_DEBOUNCE_MS = 30;
// ponytail: cap evidence, not open-document invalidations; dropping those leaves stale errors.
const MAX_WORKSPACES = 32;
const MAX_WORKSPACE_SYMBOLS = 256;
const FILE_WATCH_GLOBS = [
  "**/sqlbraid.config.mjs",
  "**/sqlbraid.config.js",
  "**/sqlbraid.config.cjs",
  "**/tsconfig*.json",
  "**/package.json",
  "**/*.{ts,tsx,mts,cts,js,jsx}",
] as const;

function uriPath(uri: string): string {
  try { return fileURLToPath(uri); } catch { return uri; }
}

function configPathFrom(value: unknown): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value) && "configPath" in value && typeof value.configPath === "string") return value.configPath;
  return undefined;
}

function rootPathFor(params: InitializeParams): string {
  const folder = params.workspaceFolders?.[0]?.uri;
  const rootUri = folder ?? params.rootUri ?? undefined;
  return rootUri ? uriPath(rootUri) : process.cwd();
}

function diagnosticSeverity(severity: CompileDiagnostic["severity"]): DiagnosticSeverity {
  return severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
}

function diagnosticFor(document: TextDocument, diagnostic: CompileDiagnostic) {
  return {
    range: {
      start: document.positionAt(diagnostic.range.start),
      end: document.positionAt(diagnostic.range.end),
    },
    severity: diagnosticSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: "sqlbraid",
    message: diagnostic.message,
  };
}

function rangeFor(document: TextDocument, start: number, end: number): Range {
  return { start: document.positionAt(start), end: document.positionAt(end) };
}

function locationFor(location: { readonly uri: string; readonly range: Range }) {
  return { uri: location.uri, range: location.range };
}

function completionKind(kind: "relation" | "column" | "routine"): CompletionItemKind {
  if (kind === "column") return CompletionItemKind.Field;
  if (kind === "routine") return CompletionItemKind.Function;
  return CompletionItemKind.Class;
}

function symbolKind(kind: "relation" | "routine" | "model"): SymbolKind {
  return kind === "routine" ? SymbolKind.Function : SymbolKind.Class;
}

function yieldToEventLoop(): Promise<void> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<void>();
  setImmediate(resolvePromise);
  return promise;
}

function pathContains(rootPath: string, fileName: string): boolean {
  const child = relative(rootPath, fileName);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function normalizedPath(path: string): string {
  return resolve(path);
}

export function startStdioLanguageServer(
  options: StdioLanguageServerOptions = { moduleSpecifiers: [...DEFAULT_MODULE_SPECIFIERS] },
  streams: LspStreams = { input: process.stdin, output: process.stdout },
): () => void {
  const serverOptions: StdioLanguageServerOptions = {
    ...options,
    moduleSpecifiers: options.moduleSpecifiers ?? [
      ...(options.moduleSpecifier ? [options.moduleSpecifier] : []),
      ...DEFAULT_MODULE_SPECIFIERS.filter((entry) => entry !== options.moduleSpecifier),
    ],
  };
  const connection = createConnection(ProposedFeatures.all, streams.input, streams.output);
  const documents = new TextDocuments(TextDocument);
  let stopped = false;
  let cleanupDone = false;
  let rootPath = process.cwd();
  let configPath = serverOptions.configPath;
  let workspaceRevision = 0;
  let workspaceFolderListener: Disposable | undefined;
  let workspaceFoldersSupported = false;
  let watchedFilesSupported = false;
  const workspaces = new Map<string, WorkspaceSlot>();
  const pendingDiagnostics = new Map<string, PendingDiagnostics>();
  const activeDiagnostics = new Map<string, ActiveDiagnostics>();

  function disposeWorkspaces(): void {
    for (const slot of workspaces.values()) slot.workspace.dispose();
    workspaces.clear();
  }

  function workspaceForFile(fileName: string): ToolingWorkspace {
    const candidate = normalizedPath(fileName);
    let best: WorkspaceSlot | undefined;
    for (const slot of workspaces.values()) {
      if (pathContains(slot.rootPath, candidate) && (!best || slot.rootPath.length > best.rootPath.length)) best = slot;
    }
    if (best) return best.workspace;
    const fallbackRoot = normalizedPath(rootPath);
    const existing = workspaces.get(fallbackRoot);
    if (existing) return existing.workspace;
    const workspace = createWorkspace({ ...serverOptions, rootPath: fallbackRoot, ...(configPath ? { configPath } : {}) });
    workspaces.set(fallbackRoot, { rootPath: fallbackRoot, workspace });
    return workspace;
  }

  function setDocumentInWorkspace(document: TextDocument): void {
    workspaceForFile(uriPath(document.uri)).setDocument(uriPath(document.uri), document.getText(), document.version);
  }

  function resetDocumentsInWorkspaces(): void {
    for (const slot of workspaces.values()) {
      for (const document of documents.all()) slot.workspace.closeDocument(uriPath(document.uri));
    }
    for (const document of documents.all()) setDocumentInWorkspace(document);
  }

  function replaceWorkspaces(rootPaths: readonly string[]): void {
    cancelAllDiagnostics();
    disposeWorkspaces();
    workspaceRevision += 1;
    const uniqueRoots = [...new Set(rootPaths.map(normalizedPath))];
    const roots = (uniqueRoots.length ? uniqueRoots : [normalizedPath(rootPath)]).slice(0, MAX_WORKSPACES);
    rootPath = roots[0] ?? rootPath;
    for (const path of roots) {
      workspaces.set(path, {
        rootPath: path,
        workspace: createWorkspace({ ...serverOptions, rootPath: path, ...(configPath ? { configPath } : {}) }),
      });
    }
    resetDocumentsInWorkspaces();
  }

  function workspaceRoots(params: InitializeParams): readonly string[] {
    const folders = params.workspaceFolders?.map((folder) => uriPath(folder.uri)) ?? [];
    return folders.length ? folders : [rootPathFor(params)];
  }

  function cancelDiagnostics(uri: string): void {
    const pending = pendingDiagnostics.get(uri);
    if (pending) {
      clearTimeout(pending.timer);
      pendingDiagnostics.delete(uri);
    }
    activeDiagnostics.get(uri)?.cancel();
    activeDiagnostics.delete(uri);
  }

  function cancelAllDiagnostics(): void {
    for (const uri of pendingDiagnostics.keys()) cancelDiagnostics(uri);
    for (const active of activeDiagnostics.values()) active.cancel();
    activeDiagnostics.clear();
  }

  function scheduleDiagnostics(uri: string): void {
    const document = documents.get(uri);
    if (!document || stopped) return;
    cancelDiagnostics(uri);
    const version = document.version;
    const timer = setTimeout(() => {
      pendingDiagnostics.delete(uri);
      void publishDiagnostics(uri, version);
    }, DIAGNOSTIC_DEBOUNCE_MS);
    pendingDiagnostics.set(uri, { version, timer });
  }

  async function computeDiagnostics(document: TextDocument, token?: Cancellation): Promise<readonly CompileDiagnostic[]> {
    if (token?.isCancellationRequested) return [];
    const currentWorkspace = workspaceForFile(uriPath(document.uri));
    const revision = workspaceRevision;
    let service: SqlBraidLanguageService;
    try {
      service = await currentWorkspace.service(token);
    } catch (error) {
      if (token?.isCancellationRequested || revision !== workspaceRevision) return [];
      throw error;
    }
    await yieldToEventLoop();
    if (token?.isCancellationRequested) return [];
    const current = documents.get(document.uri);
    if (!current || current.version !== document.version || currentWorkspace !== workspaceForFile(uriPath(document.uri)) || revision !== workspaceRevision) return [];
    const diagnostics = service.diagnostics(document.getText(), uriPath(document.uri));
    await yieldToEventLoop();
    if (token?.isCancellationRequested) return [];
    const latest = documents.get(document.uri);
    return latest && latest.version === document.version && revision === workspaceRevision ? diagnostics : [];
  }

  async function publishDiagnostics(uri: string, version: number): Promise<void> {
    const document = documents.get(uri);
    if (!document || document.version !== version || stopped) return;
    const revision = workspaceRevision;
    let cancelled = false;
    const token = { get isCancellationRequested() { return cancelled; } };
    const active: ActiveDiagnostics = { version, cancel: () => { cancelled = true; } };
    activeDiagnostics.set(uri, active);
    try {
      const diagnostics = await computeDiagnostics(document, token);
      const latest = documents.get(uri);
      if (cancelled || stopped || !latest || latest.version !== version || revision !== workspaceRevision || pendingDiagnostics.has(uri)) return;
      connection.sendDiagnostics({ uri, version, diagnostics: diagnostics.map((entry) => diagnosticFor(document, entry)) });
    } catch (error) {
      if (!cancelled && !stopped) console.error(`SQLBraid diagnostics failed for ${uri}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (activeDiagnostics.get(uri) === active) activeDiagnostics.delete(uri);
    }
  }

  function invalidateAndSchedule(): void {
    workspaceRevision += 1;
    for (const slot of workspaces.values()) slot.workspace.invalidate();
    for (const document of documents.all()) scheduleDiagnostics(document.uri);
  }

  async function withService<T>(
    uri: string,
    token: Cancellation | undefined,
    callback: (service: SqlBraidLanguageService, document: TextDocument) => T | PromiseLike<T>,
  ): Promise<T | undefined> {
    const document = documents.get(uri);
    if (!document || token?.isCancellationRequested) return undefined;
    const version = document.version;
    const currentWorkspace = workspaceForFile(uriPath(uri));
    const revision = workspaceRevision;
    let service: SqlBraidLanguageService;
    try {
      service = await currentWorkspace.service(token);
    } catch (error) {
      if (token?.isCancellationRequested || revision !== workspaceRevision) return undefined;
      throw error;
    }
    await yieldToEventLoop();
    const current = documents.get(uri);
    if (token?.isCancellationRequested || !current || current.version !== version || currentWorkspace !== workspaceForFile(uriPath(uri)) || revision !== workspaceRevision) return undefined;
    const result = await callback(service, document);
    await yieldToEventLoop();
    const latest = documents.get(uri);
    return token?.isCancellationRequested || !latest || latest.version !== version || revision !== workspaceRevision ? undefined : result;
  }

  connection.onInitialize((params) => {
    configPath = configPathFrom(params.initializationOptions) ?? serverOptions.configPath;
    workspaceFoldersSupported = params.capabilities.workspace?.workspaceFolders === true;
    watchedFilesSupported = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    replaceWorkspaces(workspaceRoots(params));
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      },
      serverInfo: { name: "SQLBraid Language Server", version: "1.0.0-rc.1" },
    };
  });

  connection.onShutdown(() => {
    cancelAllDiagnostics();
    disposeWorkspaces();
  });

  connection.onExit(() => {
    cleanup();
  });

  function updateWorkspaceFolders(event: WorkspaceFoldersChangeEvent): void {
    const removed = new Set(event.removed.map((folder) => normalizedPath(uriPath(folder.uri))));
    for (const path of removed) {
      const slot = workspaces.get(path);
      if (slot) slot.workspace.dispose();
      workspaces.delete(path);
    }
    for (const folder of event.added) {
      const path = normalizedPath(uriPath(folder.uri));
      if (workspaces.size < MAX_WORKSPACES && !workspaces.has(path)) workspaces.set(path, { rootPath: path, workspace: createWorkspace({ ...serverOptions, rootPath: path, ...(configPath ? { configPath } : {}) }) });
    }
    if (!workspaces.size) workspaces.set(normalizedPath(rootPath), { rootPath: normalizedPath(rootPath), workspace: createWorkspace({ ...serverOptions, rootPath: normalizedPath(rootPath), ...(configPath ? { configPath } : {}) }) });
    if (!workspaces.has(normalizedPath(rootPath))) rootPath = [...workspaces.keys()][0] ?? rootPath;
    workspaceRevision += 1;
    resetDocumentsInWorkspaces();
    invalidateAndSchedule();
  }

  connection.onInitialized(() => {
    if (workspaceFoldersSupported) workspaceFolderListener = connection.workspace.onDidChangeWorkspaceFolders(updateWorkspaceFolders);
    if (watchedFilesSupported) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: FILE_WATCH_GLOBS.map((globPattern) => ({ globPattern })) }).catch(
        (error: unknown) => { if (!stopped) console.error(`SQLBraid file-watch registration failed: ${String(error)}`); },
      );
    }
  });

  connection.onDidChangeWatchedFiles(() => {
    invalidateAndSchedule();
  });

  connection.onDidChangeConfiguration(() => {
    invalidateAndSchedule();
  });

  documents.onDidOpen((event) => {
    setDocumentInWorkspace(event.document);
    scheduleDiagnostics(event.document.uri);
  });

  documents.onDidChangeContent((event) => {
    setDocumentInWorkspace(event.document);
    scheduleDiagnostics(event.document.uri);
  });

  documents.onDidClose((event) => {
    cancelDiagnostics(event.document.uri);
    workspaceForFile(uriPath(event.document.uri)).closeDocument(uriPath(event.document.uri));
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onRequest("textDocument/diagnostic", async (params: { readonly textDocument: { readonly uri: string } }, token: CancellationToken) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { kind: "full", resultId: "missing", items: [] };
    const diagnostics = await computeDiagnostics(document, token);
    if (token.isCancellationRequested || documents.get(document.uri)?.version !== document.version) return { kind: "full", resultId: String(document.version), items: [] };
    return { kind: "full", resultId: String(document.version), items: diagnostics.map((entry) => diagnosticFor(document, entry)) };
  });

  connection.onHover(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.hover(document.getText(), uriPath(document.uri), document.offsetAt(params.position)));
    if (!result) return null;
    const document = documents.get(params.textDocument.uri);
    return document ? { contents: { kind: MarkupKind.Markdown, value: result.contents }, range: rangeFor(document, result.range.start, result.range.end) } : null;
  });

  connection.onCompletion(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.complete(document.getText(), uriPath(document.uri), document.offsetAt(params.position)));
    return { isIncomplete: false, items: (result ?? []).map((entry) => ({ label: entry.label, kind: completionKind(entry.kind), ...(entry.detail ? { detail: entry.detail } : {}) })) };
  });

  connection.onDefinition(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.definition(document.getText(), uriPath(document.uri), document.offsetAt(params.position)));
    return result ? locationFor(result) : null;
  });

  connection.onReferences(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.references(document.getText(), uriPath(document.uri), document.offsetAt(params.position), token));
    return (result ?? []).map(locationFor);
  });

  connection.onDocumentSymbol(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.documentSymbols(document.getText(), uriPath(document.uri)));
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return (result ?? []).map((entry) => ({ name: entry.name, detail: entry.detail, kind: SymbolKind.Function, range: rangeFor(document, entry.range.start, entry.range.end), selectionRange: rangeFor(document, entry.selectionRange.start, entry.selectionRange.end) }));
  });

  connection.onWorkspaceSymbol(async (params, token) => {
    if (token.isCancellationRequested) return [];
    const revision = workspaceRevision;
    const symbols: WorkspaceSymbol[] = [];
    for (const slot of workspaces.values()) {
      let service: SqlBraidLanguageService;
      try {
        service = await slot.workspace.service(token);
      } catch (error) {
        if (token.isCancellationRequested || revision !== workspaceRevision) return [];
        throw error;
      }
      await yieldToEventLoop();
      if (token.isCancellationRequested || revision !== workspaceRevision) return [];
      symbols.push(...service.workspaceSymbols(params.query).slice(0, MAX_WORKSPACE_SYMBOLS - symbols.length));
      if (symbols.length >= MAX_WORKSPACE_SYMBOLS) break;
    }
    return symbols.map((entry) => ({ name: entry.name, kind: symbolKind(entry.kind), location: locationFor(entry.location), ...(entry.detail ? { containerName: entry.detail } : {}) }));
  });

  connection.onSignatureHelp(async (params, token) => {
    const result = await withService(params.textDocument.uri, token, (service, document) => service.signatureHelp(document.getText(), uriPath(document.uri), document.offsetAt(params.position)));
    return result ? { signatures: [{ label: result.label, parameters: result.parameters.map((label) => ({ label })) }], activeSignature: 0, activeParameter: result.activeParameter } : null;
  });

  const documentsListener = documents.listen(connection);
  connection.listen();

  function cleanup(): void {
    if (cleanupDone) return;
    cleanupDone = true;
    stopped = true;
    cancelAllDiagnostics();
    documentsListener.dispose();
    workspaceFolderListener?.dispose();
    disposeWorkspaces();
    connection.dispose();
  }

  return cleanup;
}
