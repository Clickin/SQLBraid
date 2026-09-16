import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { createProjectContext, type TypeScriptProjectContext } from "@sqlbraid/compiler";
import { AUTHORING_MODULE_CATALOG } from "@sqlbraid/core";
import { generateModels, type CodegenResult } from "@sqlbraid/codegen";
import { hashSnapshot, parseSnapshotJson, type MetadataSnapshot } from "@sqlbraid/metadata";
import { createLanguageService } from "./service.js";
import { ConfigurationCancellationError, loadConfig, type CodegenTargetConfig } from "./config.js";
import { SOURCE_FILE_LOADER, type SourceFileLoader } from "./internal.js";
import type {
  Cancellation,
  LanguageServiceOptions,
  SourceDocument,
  SqlBraidLanguageService,
  ToolingTarget,
  ToolingWorkspace,
  WorkspaceOptions,
} from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"]);
const DEFAULT_MAX_ENTRIES = 256;
const MAX_CONFIG_CACHE = 4;
const MAX_METADATA_CACHE = 64;
const MAX_GENERATED_CACHE = 64;
const MAX_SOURCE_CACHE = 256;

export class WorkspaceCancellationError extends Error {
  constructor() {
    super("Workspace operation cancelled.");
    this.name = "WorkspaceCancellationError";
  }
}

interface FileEvidence {
  readonly path: string;
  readonly key: string;
  readonly text: string;
}

interface WorkspaceState {
  readonly key: string;
  readonly options: LanguageServiceOptions;
  readonly metadata?: MetadataSnapshot;
  readonly targets: readonly ToolingTarget[];
  readonly sources: readonly SourceDocument[];
  readonly sourceFiles: readonly string[];
}

interface GeneratedEvidence {
  readonly result: CodegenResult;
  readonly source?: string;
}

function checkCancellation(cancellation?: Cancellation): void {
  if (cancellation?.isCancellationRequested) throw new WorkspaceCancellationError();
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.min(1024, Math.floor(value)));
}

function canonicalPath(fileName: string, rootPath: string): string {
  const path = resolve(rootPath, fileName);
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isSourceFile(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function touch<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as string);
}

function digest(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value) ?? "").digest("hex");
}

async function fileEvidence(path: string, cache: Map<string, FileEvidence>, limit: number, cancellation?: Cancellation): Promise<FileEvidence | undefined> {
  checkCancellation(cancellation);
  let information;
  try {
    information = await stat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  checkCancellation(cancellation);
  const realPath = canonicalPath(path, dirname(path));
  const key = `${realPath}:${information.mtimeNs.toString(36)}:${information.ctimeNs.toString(36)}:${information.size.toString(36)}`;
  const cached = cache.get(key);
  if (cached) {
    touch(cache, key, cached, limit);
    return cached;
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  checkCancellation(cancellation);
  const result = { path: realPath, key, text };
  touch(cache, key, result, limit);
  return result;
}

function sourceDocument(path: string, text: string, version?: number): SourceDocument {
  return version === undefined ? { fileName: path, sourceText: text } : { fileName: path, sourceText: text, version };
}

function projectFile(rootPath: string): string | undefined {
  const candidate = join(rootPath, "tsconfig.json");
  return existsSync(candidate) ? candidate : undefined;
}

function projectOptions(options: LanguageServiceOptions, context?: TypeScriptProjectContext): LanguageServiceOptions {
  const modules = [...new Set([...(options.moduleSpecifiers ?? []), ...AUTHORING_MODULE_CATALOG.map(({ moduleSpecifier }) => moduleSpecifier)])];
  return {
    ...options,
    moduleSpecifiers: modules,
    ...(context ? { compilerOptions: context.compilerOptions } : {}),
  };
}

export function createWorkspace(options: WorkspaceOptions): ToolingWorkspace {
  const rootPath = canonicalPath(options.rootPath, process.cwd());
  const maxEntries = boundedLimit(options.maxEntries);
  const fileCache = new Map<string, FileEvidence>();
  const metadataCache = new Map<string, MetadataSnapshot>();
  const generatedCache = new Map<string, GeneratedEvidence>();
  const sourceCache = new Map<string, FileEvidence>();
  const configCache = new Map<string, Awaited<ReturnType<typeof loadConfig>>>();
  const documents = new Map<string, SourceDocument>();
  const requests = new Set<{ cancellation: Cancellation | undefined }>();
  let disposed = false;
  let pendingRefresh: Promise<WorkspaceState> | undefined;
  let projectContext: TypeScriptProjectContext | undefined;
  let projectContextKey: string | undefined;
  let semanticService: SqlBraidLanguageService | undefined;
  let semanticKey: string | undefined;
  let revision = 0;

  async function loadProjectContext(cancellation?: Cancellation): Promise<TypeScriptProjectContext | undefined> {
    const path = projectFile(rootPath);
    if (!path) {
      projectContext = undefined;
      projectContextKey = undefined;
      return undefined;
    }
    checkCancellation(cancellation);
    const evidence = await fileEvidence(path, fileCache, maxEntries, cancellation);
    if (evidence?.key === projectContextKey) return projectContext;
    try {
      projectContext = createProjectContext(path, { compilerOptions: options.compilerOptions });
    } catch {
      // A malformed project must not prevent conservative source inspection.
      projectContext = undefined;
    }
    projectContextKey = evidence?.key;
    return projectContext;
  }

  async function loadTarget(target: CodegenTargetConfig, configDirectory: string, cancellation?: Cancellation): Promise<ToolingTarget | undefined> {
    checkCancellation(cancellation);
    const metadataPath = canonicalPath(resolve(configDirectory, target.metadata), rootPath);
    const metadataEvidence = await fileEvidence(metadataPath, fileCache, maxEntries, cancellation);
    if (!metadataEvidence) throw new Error(`Configured metadata file does not exist: ${metadataPath}`);
    const metadataKey = `${metadataEvidence.path}:${metadataEvidence.key}`;
    let metadata = metadataCache.get(metadataKey);
    if (!metadata) {
      metadata = parseSnapshotJson(metadataEvidence.text);
      touch(metadataCache, metadataKey, metadata, Math.min(maxEntries, MAX_METADATA_CACHE));
    } else {
      touch(metadataCache, metadataKey, metadata, Math.min(maxEntries, MAX_METADATA_CACHE));
    }
    checkCancellation(cancellation);
    const outputPath = canonicalPath(resolve(configDirectory, target.outFile), rootPath);
    const outputEvidence = await fileEvidence(outputPath, fileCache, maxEntries, cancellation);
    checkCancellation(cancellation);
    const outputDocument = documents.get(outputPath);
    const outputText = outputDocument?.sourceText ?? outputEvidence?.text;
    const generatedOptions = {
      typePolicy: target.typePolicy,
      filters: target.filters,
      naming: target.naming,
      typeOverrides: target.typeOverrides,
    };
    const metadataHash = hashSnapshot(metadata);
    const optionsKey = JSON.stringify({
      typePolicy: target.typePolicy,
      filters: target.filters,
      naming: target.naming,
      typeOverrides: target.typeOverrides,
    });
    const outputKey = outputDocument
      ? `document:${outputDocument.version ?? ""}:${digest(outputText)}`
      : outputEvidence?.key ?? "missing";
    const generatedKey = `${metadataHash}:${optionsKey}:${outputPath}:${outputKey}`;
    let generated = generatedCache.get(generatedKey);
    if (!generated) {
      const result = generateModels(metadata, generatedOptions);
      generated = {
        result,
        ...(outputText === result.source ? { source: outputText } : {}),
      };
      touch(generatedCache, generatedKey, generated, Math.min(maxEntries, MAX_GENERATED_CACHE));
    } else {
      touch(generatedCache, generatedKey, generated, Math.min(maxEntries, MAX_GENERATED_CACHE));
    }
    return {
      name: target.name,
      metadata,
      metadataPath,
      metadataSource: metadataEvidence.text,
      outFile: outputPath,
      ...(generated.source === undefined ? {} : { generatedSource: generated.source }),
      generation: generated.result,
    };
  }

  async function loadSources(context: TypeScriptProjectContext | undefined, targets: readonly ToolingTarget[], cancellation?: Cancellation): Promise<{ readonly sources: readonly SourceDocument[]; readonly sourceFiles: readonly string[] }> {
    const result = new Map<string, SourceDocument>();
    const generatedPaths = new Map(targets.filter((target) => target.outFile).map((target) => [canonicalPath(target.outFile as string, rootPath), target.generatedSource]));
    for (const document of documents.values()) {
      checkCancellation(cancellation);
      if (generatedPaths.has(document.fileName) && generatedPaths.get(document.fileName) === undefined) continue;
      result.set(document.fileName, document);
    }
    checkCancellation(cancellation);
    const diskFiles = [...(context?.fileNames ?? [])]
      .map((fileName) => canonicalPath(fileName, rootPath))
      .filter((fileName) => isSourceFile(fileName))
      .sort();
    checkCancellation(cancellation);
    // Generated declarations are evidence only when they match pure in-memory output.
    for (const target of targets) {
      checkCancellation(cancellation);
      if (!target.generatedSource || !target.outFile) continue;
      const path = canonicalPath(target.outFile, rootPath);
      if (!result.has(path)) result.set(path, sourceDocument(path, target.generatedSource));
    }
    return { sources: [...result.values()], sourceFiles: diskFiles.filter((fileName) => !generatedPaths.has(fileName)) };
  }

  const loadSourceFile: SourceFileLoader = async (fileName, cancellation) => {
    checkCancellation(cancellation);
    const path = canonicalPath(fileName, rootPath);
    const document = documents.get(path);
    if (document) return document;
    const evidence = await fileEvidence(path, sourceCache, Math.min(maxEntries, MAX_SOURCE_CACHE), cancellation);
    return evidence ? sourceDocument(evidence.path, evidence.text) : undefined;
  };

  async function rebuild(cancellation?: Cancellation): Promise<WorkspaceState> {
    checkCancellation(cancellation);
    const configPath = options.configPath ? canonicalPath(options.configPath, rootPath) : undefined;
    let loaded;
    if (configPath || ["sqlbraid.config.mjs", "sqlbraid.config.js", "sqlbraid.config.cjs"].some((name) => existsSync(join(rootPath, name)))) {
      const key = configPath ?? ["sqlbraid.config.mjs", "sqlbraid.config.js", "sqlbraid.config.cjs"].map((name) => join(rootPath, name)).find((path) => existsSync(path));
      if (key) {
        const evidence = await fileEvidence(key, fileCache, maxEntries, cancellation);
        const cacheKey = evidence?.key ?? key;
        loaded = configCache.get(cacheKey);
        if (!loaded) {
          loaded = await loadConfig(options.configPath, rootPath, cancellation);
          touch(configCache, cacheKey, loaded, MAX_CONFIG_CACHE);
        } else touch(configCache, cacheKey, loaded, MAX_CONFIG_CACHE);
      }
    }
    const context = await loadProjectContext(cancellation);
    const semanticOptions = projectOptions(options, context);
    const configuredTargets: ToolingTarget[] = [];
    if (loaded?.config.codegen?.targets) {
      for (const target of loaded.config.codegen.targets) {
        const evidence = await loadTarget(target, loaded.directory, cancellation);
        if (evidence) configuredTargets.push(evidence);
      }
    }
    const targets: readonly ToolingTarget[] = (configuredTargets.length ? configuredTargets : [...(options.targets ?? [])]).map((target): ToolingTarget => {
      if (!target.outFile) return target;
      const outputDocument = documents.get(canonicalPath(target.outFile, rootPath));
      if (!outputDocument) return target;
      if (target.generation?.source === outputDocument.sourceText) return { ...target, generatedSource: outputDocument.sourceText };
      const { generatedSource: _generatedSource, ...withoutStaleEvidence } = target;
      return withoutStaleEvidence;
    });
    const { sources, sourceFiles } = await loadSources(context, targets, cancellation);
    const metadata = options.metadata;
    checkCancellation(cancellation);
    const key = digest({
      projectContextKey,
      configPath: loaded?.path,
      metadata: metadata ? hashSnapshot(metadata) : undefined,
      targets: targets.map((target) => ({
        name: target.name,
        metadataPath: target.metadataPath,
        outFile: target.outFile,
        generation: target.generation ? [target.generation.metadataHash, target.generation.optionsHash, target.generation.source] : undefined,
        generatedSource: target.generatedSource,
      })),
      sources: sources.map((source) => [source.fileName, source.version, digest(source.sourceText)]),
      sourceFiles,
    });
    return { key, options: semanticOptions, metadata, targets, sources, sourceFiles };
  }

  function refresh(): Promise<WorkspaceState> {
    if (pendingRefresh) return pendingRefresh;
    const startedRevision = revision;
    const cancellation: Cancellation = {
      get isCancellationRequested() {
        if (disposed || revision !== startedRevision) return true;
        for (const request of requests) if (!request.cancellation?.isCancellationRequested) return false;
        return true;
      },
    };
    // Stat cached evidence on each refresh: generic clients need not implement watchers.
    pendingRefresh = rebuild(cancellation).finally(() => {
      pendingRefresh = undefined;
    });
    return pendingRefresh;
  }

  function waitForRefresh(pending: Promise<WorkspaceState>, cancellation?: Cancellation): Promise<WorkspaceState> {
    if (!cancellation) return pending;
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (cancellation.isCancellationRequested || disposed) {
          clearInterval(timer);
          reject(new WorkspaceCancellationError());
        }
      }, 10);
      pending.then(
        (value) => { clearInterval(timer); resolve(value); },
        (error: unknown) => { clearInterval(timer); reject(error); },
      );
    });
  }

  async function service(cancellation?: Cancellation): Promise<SqlBraidLanguageService> {
    if (disposed) throw new Error("Workspace has been disposed.");
    checkCancellation(cancellation);
    const request = { cancellation };
    requests.add(request);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentRevision = revision;
        let refreshed: WorkspaceState;
        try {
          refreshed = await waitForRefresh(refresh(), cancellation);
        } catch (error) {
          if (disposed || cancellation?.isCancellationRequested) throw new WorkspaceCancellationError();
          if (error instanceof WorkspaceCancellationError || error instanceof ConfigurationCancellationError) continue;
          throw error;
        }
        checkCancellation(cancellation);
        if (disposed) throw new WorkspaceCancellationError();
        if (currentRevision !== revision) continue;
        if (semanticService && semanticKey === refreshed.key) return semanticService;
        semanticService = createLanguageService({
          ...refreshed.options,
          metadata: refreshed.metadata,
          targets: refreshed.targets,
          sources: refreshed.sources,
          maxEntries,
          sourceFiles: refreshed.sourceFiles,
          [SOURCE_FILE_LOADER]: loadSourceFile,
        } as LanguageServiceOptions);
        semanticKey = refreshed.key;
        return semanticService;
      }
      throw new WorkspaceCancellationError();
    } finally {
      requests.delete(request);
    }
  }

  return {
    setDocument(fileName, sourceText, version) {
      if (disposed) throw new Error("Workspace has been disposed.");
      const path = canonicalPath(fileName, rootPath);
      documents.delete(path);
      documents.set(path, sourceDocument(path, sourceText, version));
      revision += 1;
    },
    closeDocument(fileName) {
      documents.delete(canonicalPath(fileName, rootPath));
      revision += 1;
    },
    service,
    invalidate() {
      semanticService = undefined;
      semanticKey = undefined;
      projectContext = undefined;
      projectContextKey = undefined;
      configCache.clear();
      revision += 1;
    },
    dispose() {
      disposed = true;
      documents.clear();
      fileCache.clear();
      metadataCache.clear();
      generatedCache.clear();
      sourceCache.clear();
      configCache.clear();
      semanticService = undefined;
      semanticKey = undefined;
      projectContext = undefined;
      projectContextKey = undefined;
    },
  };
}
