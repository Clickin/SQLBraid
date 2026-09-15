import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import {
  findProjectEvidence,
  isProjectEvidencePath,
  SQLBRAID_DOCUMENT_GLOB,
  SQLBRAID_CONFIG_FILES,
  type ProjectEvidence,
} from "./project.js";

const EXTENSION_VERSION = "0.1.0-rc.1";
const LANGUAGE_SERVER_VERSION = "0.1.0-rc.1";
const CLI_VERSION = "0.1.0-rc.1";
const SERVER_ID = "sqlbraid-language-server";

function nodeEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

type RunningProject = {
  readonly folder: vscode.WorkspaceFolder;
  readonly client: LanguageClient;
  readonly watchers: readonly vscode.FileSystemWatcher[];
  evidence: ProjectEvidence;
};

function dependencyEntry(specifier: string, sibling: string): { readonly path: string; readonly packageRoot: string } {
  let directory = __dirname;
  let packageRoot: string | undefined;
  for (;;) {
    const candidate = join(directory, "node_modules", ...specifier.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      packageRoot = candidate;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!packageRoot) throw new Error(`SQLBraid dependency is not installed: ${specifier}`);
  const path = join(packageRoot, "dist", sibling);
  if (!existsSync(path)) throw new Error(`SQLBraid ${specifier} entry is missing: ${path}`);
  return { path, packageRoot };
}

function dependencyVersion(packageRoot: string): string {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error(`SQLBraid dependency has no version: ${packageRoot}`);
  return packageJson.version;
}

function resolveMatchingDependencies(): { readonly serverPath: string; readonly cliPath: string } {
  const server = dependencyEntry("@sqlbraid/language-server", "cli.js");
  const cli = dependencyEntry("@sqlbraid/cli", "index.js");
  if (dependencyVersion(server.packageRoot) !== LANGUAGE_SERVER_VERSION) {
    throw new Error(`SQLBraid language server ${LANGUAGE_SERVER_VERSION} is required; found ${dependencyVersion(server.packageRoot)}.`);
  }
  if (dependencyVersion(cli.packageRoot) !== CLI_VERSION) {
    throw new Error(`SQLBraid CLI ${CLI_VERSION} is required; found ${dependencyVersion(cli.packageRoot)}.`);
  }
  return { serverPath: server.path, cliPath: cli.path };
}

function projectWatchers(folder: vscode.WorkspaceFolder): vscode.FileSystemWatcher[] {
  const patterns = [
    ...SQLBRAID_CONFIG_FILES.map((fileName) => `**/${fileName}`),
    "**/tsconfig*.json",
    "**/package.json",
    "**/*.{ts,tsx,mts,cts,js,jsx}",
  ];
  return patterns.map((pattern) => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern)));
}

function executeCli(cliPath: string, args: readonly string[], cwd: string): Promise<{ readonly code: number; readonly output: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ readonly code: number; readonly output: string }>();
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: nodeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code: code ?? 1, output }));
  return promise;
}

function workspaceFolderForDocument(document: vscode.TextDocument): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

class SqlBraidProjects implements vscode.Disposable {
  private readonly projects = new Map<string, RunningProject>();
  private readonly output = vscode.window.createOutputChannel("SQLBraid");
  private refreshQueue = Promise.resolve();
  private disposed = false;

  constructor(context: vscode.ExtensionContext) {
    for (const pattern of ["**/package.json", ...SQLBRAID_CONFIG_FILES.map((fileName) => `**/${fileName}`)]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      context.subscriptions.push(
        watcher,
        watcher.onDidChange(() => this.scheduleRefresh()),
        watcher.onDidCreate(() => this.scheduleRefresh()),
        watcher.onDidDelete(() => this.scheduleRefresh()),
      );
    }
    context.subscriptions.push(
      this.output,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidCreateFiles((event) => this.handleProjectFileEvents(event.files)),
      vscode.workspace.onDidDeleteFiles((event) => this.handleProjectFileEvents(event.files)),
      vscode.workspace.onDidRenameFiles((event) => this.handleProjectFileEvents(event.files.flatMap((file) => [file.oldUri, file.newUri]))),
      vscode.workspace.onDidSaveTextDocument((document) => this.handleProjectFileEvents([document.uri])),
      vscode.commands.registerCommand("sqlbraid.generateModels", () => this.runCodegen(false)),
      vscode.commands.registerCommand("sqlbraid.checkGeneratedModels", () => this.runCodegen(true)),
      vscode.commands.registerCommand("sqlbraid.reloadProject", () => this.reloadProject()),
    );
  }

  start(): void {
    this.scheduleRefresh();
  }

  dispose(): void {
    void this.stop();
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const projects = [...this.projects.values()];
    this.projects.clear();
    for (const project of projects) {
      for (const watcher of project.watchers) watcher.dispose();
    }
    await Promise.all(projects.map((project) => project.client.stop()));
    this.output.dispose();
  }

  private scheduleRefresh(): void {
    this.refreshQueue = this.refreshQueue.then(() => this.refresh()).catch((error: unknown) => {
      console.error("[SQLBraid] project refresh failed:", error);
      this.output.appendLine(String(error));
      void vscode.window.showErrorMessage(`SQLBraid could not refresh the project: ${String(error)}`);
    });
  }

  private handleProjectFileEvents(uris: readonly vscode.Uri[]): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (uris.some((uri) => folders.some((folder) => isProjectEvidencePath(uri.fsPath, folder.uri.fsPath)))) this.scheduleRefresh();
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const activeRoots = new Set(folders.map((folder) => folder.uri.toString()));
    for (const [root, project] of this.projects) {
      if (!activeRoots.has(root)) await this.stopProject(root, project);
    }
    for (const folder of folders) {
      const evidence = await findProjectEvidence(folder.uri.fsPath);
      const current = this.projects.get(folder.uri.toString());
      if (!evidence && current) {
        await this.stopProject(folder.uri.toString(), current);
      } else if (evidence && !current) {
        await this.startProject(folder, evidence);
      } else if (evidence && current) {
        current.evidence = evidence;
      }
    }
  }

  private async startProject(folder: vscode.WorkspaceFolder, evidence: ProjectEvidence): Promise<void> {
    const { serverPath } = resolveMatchingDependencies();
    const watchers = projectWatchers(folder);
    const serverOptions: ServerOptions = {
      run: { command: process.execPath, args: [serverPath], options: { cwd: folder.uri.fsPath, env: nodeEnvironment() } },
      debug: { command: process.execPath, args: [serverPath], options: { cwd: folder.uri.fsPath, env: nodeEnvironment() } },
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: "file", language: "typescript" },
        { scheme: "file", language: "typescriptreact" },
      ],
      workspaceFolder: folder,
      synchronize: { fileEvents: watchers },
      outputChannelName: "SQLBraid Language Server",
    };
    const client = new LanguageClient(SERVER_ID, `SQLBraid (${folder.name})`, serverOptions, clientOptions);
    // LSP 3.17 selectors accept strings; scope native VS Code registrations
    // at the client's conversion boundary instead of serializing OS path globs.
    const convertSelector = client.protocol2CodeConverter.asDocumentSelector;
    client.protocol2CodeConverter.asDocumentSelector = (selector) =>
      scopeDocumentSelector(convertSelector(selector), folder.uri);
    const project: RunningProject = { folder, client, watchers, evidence };
    this.projects.set(folder.uri.toString(), project);
    try {
      await client.start();
      this.output.appendLine(`Started SQLBraid ${EXTENSION_VERSION} for ${folder.uri.fsPath} (${evidence.kind} evidence).`);
    } catch (error) {
      console.error(`[SQLBraid] language server failed for ${folder.uri.fsPath}:`, error);
      this.projects.delete(folder.uri.toString());
      for (const watcher of watchers) watcher.dispose();
      throw error;
    }
  }

  private async stopProject(root: string, project: RunningProject): Promise<void> {
    this.projects.delete(root);
    for (const watcher of project.watchers) watcher.dispose();
    await project.client.stop();
    this.output.appendLine(`Stopped SQLBraid for ${project.folder.uri.fsPath}.`);
  }

  private notifyConfigurationChanged(): void {
    for (const project of this.projects.values()) {
      project.client.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
    }
  }

  private async runCodegen(check: boolean): Promise<void> {
    const folder = vscode.window.activeTextEditor ? workspaceFolderForDocument(vscode.window.activeTextEditor.document) : vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("SQLBraid needs an open workspace folder.");
      return;
    }
    const evidence = await findProjectEvidence(folder.uri.fsPath);
    if (!evidence) {
      void vscode.window.showWarningMessage("SQLBraid is not configured in this workspace folder.");
      return;
    }
    try {
      const { cliPath } = resolveMatchingDependencies();
      const result = await executeCli(cliPath, ["codegen", ...(check ? ["--check"] : [])], folder.uri.fsPath);
      if (result.output) this.output.append(result.output);
      if (result.code !== 0) {
        void vscode.window.showErrorMessage(`SQLBraid codegen ${check ? "check" : "generation"} failed.`);
      } else {
        void vscode.window.showInformationMessage(`SQLBraid models ${check ? "are up to date" : "generated"}.`);
        this.notifyConfigurationChanged();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`SQLBraid CLI failed: ${String(error)}`);
    }
  }

  private async reloadProject(): Promise<void> {
    const folder = vscode.window.activeTextEditor ? workspaceFolderForDocument(vscode.window.activeTextEditor.document) : vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("SQLBraid needs an open workspace folder.");
      return;
    }
    const root = folder.uri.toString();
    const current = this.projects.get(root);
    if (current) await this.stopProject(root, current);
    const evidence = await findProjectEvidence(folder.uri.fsPath);
    if (evidence) await this.startProject(folder, evidence);
  }
}

let activeProjects: SqlBraidProjects | undefined;

export function scopeDocumentSelector(selector: vscode.DocumentSelector, folder: vscode.Uri): vscode.DocumentSelector {
  const pattern = new vscode.RelativePattern(folder, SQLBRAID_DOCUMENT_GLOB);
  const filters = typeof selector === "string" ? [selector] : Array.isArray(selector) ? selector : [selector];
  return filters.map((filter) => typeof filter === "string"
    ? { language: filter, pattern }
    : { ...filter, pattern });
}

export function activate(context: vscode.ExtensionContext): void {
  const projects = new SqlBraidProjects(context);
  activeProjects = projects;
  context.subscriptions.push(projects);
  projects.start();
}

export async function deactivate(): Promise<void> {
  await activeProjects?.stop();
  activeProjects = undefined;
}
