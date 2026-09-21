import ts from "typescript";
import { dirname } from "node:path";
import {
  compilerOptionsFor,
  defaultCompilerOptions,
  discoverQueries,
  impliedNodeFormatForFileName,
  scriptKindForFileName,
  sourceFileFor,
  sourceFileScriptKind,
} from "./discovery.js";
import { hasMappedRowsTag, lowerSourceFile, mappedRowType, queryNodeFor } from "./lowering.js";
import type {
  CompileDiagnostic,
  DetailedCheckResult,
  DiscoveredQuery,
  OverlayOptions,
  OverlayQueryType,
  SourceAnalysisResult,
  SourceRange,
  TypeScriptCheckOptions,
  TypeScriptProjectContext,
  TypeScriptSourceContext,
  VirtualTypeScriptOverlay,
} from "./types.js";
import type { LoweredSource } from "./lowering.js";

/** Build a checker/runtime overlay with inferred row types and lowered virtual source. */
export function createVirtualOverlay(
  sourceText: string,
  fileName: string,
  options: OverlayOptions,
): VirtualTypeScriptOverlay {
  const compilerOptions = compilerOptionsFor(options);
  let sourceFile = sourceFileFor(sourceText, fileName, options);
  let typeChecker = options.typeChecker;
  let discovered = discoverQueries(sourceText, fileName, {
    ...options,
    compilerOptions,
    sourceFile,
    ...(typeChecker ? { typeChecker } : {}),
  });
  if (!typeChecker && hasMappedRowsTag(sourceFile)) {
    const originalProgram = ts.createProgram(
      [fileName],
      compilerOptions,
      sourceHost(compilerOptions, fileName, sourceText),
    );
    sourceFile = sourceFileInProgram(originalProgram, fileName) ?? sourceFile;
    typeChecker = originalProgram.getTypeChecker();
    discovered = discoverQueries(sourceText, fileName, { ...options, compilerOptions, sourceFile, typeChecker });
  }
  const queryTypes: OverlayQueryType[] = discovered.queries.map((query) => {
    const node = queryNodeFor(sourceFile, query);
    return {
      range: query.range,
      rowType:
        query.declaredRowType ??
        (query.mappedRow && typeChecker && node
          ? (mappedRowType(node, typeChecker) ?? "unknown")
          : query.declaredResultKind === "command"
            ? 'import("@sqlbraid/core").CommandResult'
            : "unknown"),
      resultKind: query.declaredResultKind,
    };
  });
  const transformed = lowerSourceFile(sourceFile, discovered, "runtime");
  return {
    sourceFileName: fileName,
    sourceText,
    virtualSourceText: transformed.sourceText,
    queryTypes,
    diagnostics: transformed.diagnostics,
  };
}

function virtualSourceFile(
  name: string,
  text: string,
  languageVersion: ts.ScriptTarget,
  original?: ts.SourceFile,
  impliedNodeFormat?: ts.ModuleKind.ESNext | ts.ModuleKind.CommonJS,
): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    name,
    text,
    languageVersion,
    true,
    original ? sourceFileScriptKind(original) : scriptKindForFileName(name),
  );
  if (original?.impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = original.impliedNodeFormat;
  else if (impliedNodeFormat !== undefined) sourceFile.impliedNodeFormat = impliedNodeFormat;
  return sourceFile;
}

function virtualHost(
  compilerOptions: ts.CompilerOptions,
  virtualFiles: ReadonlyMap<string, string>,
  originalFiles: ReadonlyMap<string, ts.SourceFile> = new Map(),
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  return {
    ...defaultHost,
    getSourceFile(name, languageVersion: ts.ScriptTarget) {
      const text = virtualFiles.get(ts.sys.resolvePath(name));
      if (text === undefined) return defaultHost.getSourceFile(name, languageVersion);
      return virtualSourceFile(
        name,
        text,
        languageVersion,
        originalFiles.get(ts.sys.resolvePath(name)),
        impliedNodeFormatForFileName(name, compilerOptions),
      );
    },
    readFile(name) {
      return virtualFiles.get(ts.sys.resolvePath(name)) ?? defaultHost.readFile(name);
    },
    fileExists(name) {
      return virtualFiles.has(ts.sys.resolvePath(name)) || defaultHost.fileExists(name);
    },
  };
}

function sourceHost(compilerOptions: ts.CompilerOptions, fileName: string, sourceText: string): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const canonical = ts.sys.resolvePath(fileName);
  return {
    ...defaultHost,
    getSourceFile(name, languageVersion: ts.ScriptTarget) {
      return ts.sys.resolvePath(name) === canonical
        ? virtualSourceFile(
            name,
            sourceText,
            languageVersion,
            undefined,
            impliedNodeFormatForFileName(name, compilerOptions),
          )
        : defaultHost.getSourceFile(name, languageVersion);
    },
    readFile(name) {
      return ts.sys.resolvePath(name) === canonical ? sourceText : defaultHost.readFile(name);
    },
    fileExists(name) {
      return ts.sys.resolvePath(name) === canonical || defaultHost.fileExists(name);
    },
  };
}

function sourceFileInProgram(program: ts.Program, fileName: string): ts.SourceFile | undefined {
  const canonical = ts.sys.resolvePath(fileName);
  return program.getSourceFiles().find((sourceFile) => ts.sys.resolvePath(sourceFile.fileName) === canonical);
}

function mapGeneratedRange(record: FileRecord, start: number, _end: number): SourceRange {
  const origin = record.lowered.mappingOrigins
    .filter((candidate) => start >= candidate.generatedStart && start < candidate.generatedEnd)
    .toSorted(
      (left, right) => left.generatedEnd - left.generatedStart - (right.generatedEnd - right.generatedStart),
    )[0];
  const fallbackOrigin =
    origin ??
    record.lowered.origins.find((candidate) => start >= candidate.generatedStart && start < candidate.generatedEnd);
  if (fallbackOrigin) {
    const query = record.discovered.queries.find(
      (candidate) =>
        candidate.range.start === fallbackOrigin.sourceStart && candidate.range.end === fallbackOrigin.sourceEnd,
    );
    if (query) {
      const generatedQuery = record.lowered.sourceText.slice(
        fallbackOrigin.generatedStart,
        fallbackOrigin.generatedEnd,
      );
      const callbackStart = generatedQuery.indexOf("=> {");
      const searchStart = callbackStart >= 0 ? callbackStart : 0;
      const bindingOffsets = new Map<number, number>();
      for (const expression of new Set(query.bindings.map((binding) => binding.expression))) {
        const bindings = query.bindings
          .filter((binding) => binding.expression === expression)
          .toSorted((left, right) => left.interpolation - right.interpolation);
        let offset = searchStart;
        for (const binding of bindings) {
          let found = generatedQuery.indexOf(expression, offset);
          while (found >= 0) {
            const before = generatedQuery[found - 1];
            const after = generatedQuery[found + expression.length];
            const identifierExpression = /[$\w]/u.test(expression[0] ?? "") && /[$\w]/u.test(expression.at(-1) ?? "");
            if (!identifierExpression || (!/[$\w]/u.test(before ?? "") && !/[$\w]/u.test(after ?? ""))) break;
            found = generatedQuery.indexOf(expression, found + Math.max(1, expression.length));
          }
          if (found < 0) continue;
          bindingOffsets.set(binding.interpolation, found);
          offset = found + Math.max(1, expression.length);
        }
      }
      for (const binding of query.bindings) {
        const bindingOffset = bindingOffsets.get(binding.interpolation);
        if (
          bindingOffset !== undefined &&
          start >= fallbackOrigin.generatedStart + bindingOffset &&
          start <= fallbackOrigin.generatedStart + bindingOffset + binding.expression.length
        )
          return binding.range;
      }
      return { start: fallbackOrigin.sourceStart, end: fallbackOrigin.sourceEnd };
    }
    return { start: fallbackOrigin.sourceStart, end: fallbackOrigin.sourceEnd };
  }
  const nearest = record.discovered.queries.reduce<{ readonly distance: number; readonly query?: DiscoveredQuery }>(
    (best, query) => {
      const distance = Math.abs(query.range.start - start);
      return distance < best.distance ? { distance, query } : best;
    },
    { distance: Number.POSITIVE_INFINITY },
  );
  return nearest.query?.templateRange ?? { start: 0, end: Math.min(1, record.sourceText.length) };
}

interface FileRecord {
  readonly fileName: string;
  readonly sourceText: string;
  readonly discovered: SourceAnalysisResult;
  readonly lowered: LoweredSource;
}

function addDiagnostic(output: CompileDiagnostic[], seen: Set<string>, diagnostic: CompileDiagnostic): void {
  const key = `${diagnostic.code}:${diagnostic.range.start}:${diagnostic.range.end}:${diagnostic.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  output.push(diagnostic);
}

function tsDiagnostic(diagnostic: ts.Diagnostic, rangeValue: SourceRange): CompileDiagnostic {
  return {
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    severity: "error",
    range: rangeValue,
  };
}

function programDiagnostics(
  records: readonly FileRecord[],
  program: ts.Program,
  mapRange: (record: FileRecord, start: number, end: number) => SourceRange,
): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!diagnostic.file) {
      addDiagnostic(diagnostics, seen, tsDiagnostic(diagnostic, { start: 0, end: 0 }));
      continue;
    }
    const record = records.find(
      (candidate) => ts.sys.resolvePath(candidate.fileName) === ts.sys.resolvePath(diagnostic.file?.fileName ?? ""),
    );
    if (!record) continue;
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 1);
    addDiagnostic(diagnostics, seen, tsDiagnostic(diagnostic, mapRange(record, start, end)));
  }
  return diagnostics;
}

function braidDiagnostics(records: readonly FileRecord[]): readonly CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const record of records)
    for (const diagnostic of record.lowered.diagnostics) addDiagnostic(diagnostics, seen, diagnostic);
  return diagnostics;
}

function overlayDiagnostics(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
  return programDiagnostics(records, virtualProgram, mapGeneratedRange);
}

function sameDiagnosticSource(left: CompileDiagnostic, right: CompileDiagnostic): boolean {
  if (left.code !== right.code || left.message !== right.message || left.severity !== right.severity) return false;
  if (left.range.start === right.range.start && left.range.end === right.range.end) return true;
  const leftContainsRight = left.range.start <= right.range.start && left.range.end >= right.range.end;
  const rightContainsLeft = right.range.start <= left.range.start && right.range.end >= left.range.end;
  return (
    (leftContainsRight || rightContainsLeft) &&
    (left.range.start === right.range.start || left.range.end === right.range.end)
  );
}

function overlayOnlyDiagnostics(
  overlay: readonly CompileDiagnostic[],
  native: readonly CompileDiagnostic[],
): readonly CompileDiagnostic[] {
  const unmatchedNative = [...native];
  const only: CompileDiagnostic[] = [];
  for (const diagnostic of overlay) {
    const match = unmatchedNative
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => sameDiagnosticSource(diagnostic, candidate))
      .toSorted((left, right) => {
        const leftWidth = left.candidate.range.end - left.candidate.range.start;
        const rightWidth = right.candidate.range.end - right.candidate.range.start;
        const diagnosticWidth = diagnostic.range.end - diagnostic.range.start;
        return (
          Math.abs(leftWidth - diagnosticWidth) - Math.abs(rightWidth - diagnosticWidth) ||
          left.candidate.range.start - right.candidate.range.start ||
          left.candidate.range.end - right.candidate.range.end
        );
      })[0];
    if (!match) {
      only.push(diagnostic);
      continue;
    }
    unmatchedNative.splice(match.index, 1);
  }
  return only;
}

function checkVirtualRecords(records: readonly FileRecord[], virtualProgram: ts.Program): readonly CompileDiagnostic[] {
  return [...braidDiagnostics(records), ...overlayDiagnostics(records, virtualProgram)];
}

/** Create an in-memory TypeScript program for one source file and its mapped diagnostics. */
export function createSourceContext(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): TypeScriptSourceContext {
  const compilerOptions = compilerOptionsFor(options);
  const program = ts.createProgram([fileName], compilerOptions, sourceHost(compilerOptions, fileName, sourceText));
  const sourceFile =
    sourceFileInProgram(program, fileName) ?? sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  return { compilerOptions, program, sourceFile, checker: program.getTypeChecker() };
}

/** Check one source file using both native TypeScript and the lowered overlay. */
export function checkSource(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): readonly CompileDiagnostic[] {
  const context = createSourceContext(sourceText, fileName, options);
  const { compilerOptions, sourceFile: originalSourceFile } = context;
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: context.checker };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const lowered = lowerSourceFile(originalSourceFile, discovered, "checker");
  const records: FileRecord[] = [{ fileName, sourceText, discovered, lowered }];
  const virtualFiles = new Map([[ts.sys.resolvePath(fileName), lowered.sourceText]]);
  const originalFiles = new Map([[ts.sys.resolvePath(fileName), originalSourceFile]]);
  const virtualProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    virtualHost(compilerOptions, virtualFiles, originalFiles),
  );
  return checkVirtualRecords(records, virtualProgram);
}

/** Return separated native, overlay, Braid, and overlay-only diagnostics for one source file. */
export function checkSourceDetailed(
  sourceText: string,
  fileName: string,
  options: TypeScriptCheckOptions,
): DetailedCheckResult {
  const context = createSourceContext(sourceText, fileName, options);
  const { compilerOptions, sourceFile: originalSourceFile } = context;
  const fileOptions = { ...options, compilerOptions, sourceFile: originalSourceFile, typeChecker: context.checker };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const lowered = lowerSourceFile(originalSourceFile, discovered, "checker");
  const records: FileRecord[] = [{ fileName, sourceText, discovered, lowered }];
  const virtualFiles = new Map([[ts.sys.resolvePath(fileName), lowered.sourceText]]);
  const originalFiles = new Map([[ts.sys.resolvePath(fileName), originalSourceFile]]);
  const virtualProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    virtualHost(compilerOptions, virtualFiles, originalFiles),
  );
  const braid = braidDiagnostics(records);
  const native = programDiagnostics(records, context.program, (record, start, end) => {
    const boundedStart = Math.max(0, Math.min(record.sourceText.length, start));
    const boundedEnd = Math.max(boundedStart, Math.min(record.sourceText.length, end));
    return { start: boundedStart, end: boundedEnd };
  });
  const overlay = overlayDiagnostics(records, virtualProgram);
  return {
    braidDiagnostics: braid,
    nativeTypeScriptDiagnostics: native,
    overlayTypeScriptDiagnostics: overlay,
    overlayOnlyDiagnostics: overlayOnlyDiagnostics(overlay, native),
  };
}

function readProject(
  projectFile: string,
  compilerOptionsOverride?: ts.CompilerOptions,
): { readonly compilerOptions: ts.CompilerOptions; readonly fileNames: readonly string[] } {
  const normalizedProjectFile = ts.sys.resolvePath(projectFile);
  const config = ts.readConfigFile(normalizedProjectFile, ts.sys.readFile);
  if (config.error)
    throw new Error(`TS${config.error.code}: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(normalizedProjectFile),
    compilerOptionsOverride,
    normalizedProjectFile,
  );
  if (parsed.errors.length)
    throw new Error(
      parsed.errors
        .map((diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)
        .join("\n"),
    );
  return { compilerOptions: parsed.options, fileNames: parsed.fileNames };
}

/** Load a tsconfig-backed project context; project files are read through TypeScript's normal config rules. */
export function createProjectContext(
  projectFile: string,
  options: Pick<TypeScriptCheckOptions, "compilerOptions"> = {},
): TypeScriptProjectContext {
  const parsed = readProject(projectFile, options.compilerOptions);
  const compilerOptions = { ...parsed.compilerOptions, ...options.compilerOptions };
  const program = ts.createProgram(parsed.fileNames, compilerOptions);
  return {
    projectFile: ts.sys.resolvePath(projectFile),
    compilerOptions,
    fileNames: parsed.fileNames,
    program,
    checker: program.getTypeChecker(),
  };
}

/** Check every project source through the lowered virtual program; config failures become diagnostics. */
export function checkProject(projectFile: string, options: TypeScriptCheckOptions = {}): readonly CompileDiagnostic[] {
  try {
    const context = createProjectContext(projectFile, options);
    const records: FileRecord[] = [];
    const virtualFiles = new Map<string, string>();
    const originalFiles = new Map<string, ts.SourceFile>();
    for (const fileName of context.fileNames) {
      const sourceFile = sourceFileInProgram(context.program, fileName);
      const sourceText = sourceFile?.text ?? ts.sys.readFile(fileName);
      if (sourceText === undefined || !sourceFile) continue;
      const fileOptions = {
        ...options,
        compilerOptions: context.compilerOptions,
        sourceFile,
        typeChecker: context.checker,
      };
      const discovered = discoverQueries(sourceText, fileName, fileOptions);
      const lowered = lowerSourceFile(sourceFile, discovered, "checker");
      records.push({ fileName, sourceText, discovered, lowered });
      virtualFiles.set(ts.sys.resolvePath(fileName), lowered.sourceText);
      originalFiles.set(ts.sys.resolvePath(fileName), sourceFile);
    }
    const virtualProgram = ts.createProgram(
      context.fileNames,
      context.compilerOptions,
      virtualHost(context.compilerOptions, virtualFiles, originalFiles),
    );
    return checkVirtualRecords(records, virtualProgram);
  } catch (error) {
    return [
      {
        code: "BRAID_PROJECT_CONFIG",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        range: { start: 0, end: 0 },
      },
    ];
  }
}

function emitCompilerOptions(options: OverlayOptions): ts.CompilerOptions {
  const provided = options.compilerOptions ?? {};
  const module = provided.module ?? ts.ModuleKind.NodeNext;
  const compilerOptions: ts.CompilerOptions = {
    ...defaultCompilerOptions(),
    target: provided.target ?? ts.ScriptTarget.ES2022,
    module,
    moduleResolution:
      provided.moduleResolution ??
      (module === ts.ModuleKind.Node16 || module === ts.ModuleKind.NodeNext
        ? ts.ModuleResolutionKind.NodeNext
        : ts.ModuleResolutionKind.Node10),
    sourceMap: provided.inlineSourceMap ? false : (provided.sourceMap ?? true),
    ...provided,
    noEmit: false,
  };
  if (compilerOptions.inlineSourceMap) compilerOptions.sourceMap = false;
  return compilerOptions;
}

/** Emit transpiled JavaScript after SQLBraid lowering; Vite users should let Vite own this transpilation step. */
export function emitSource(
  sourceText: string,
  fileName: string,
  options: OverlayOptions,
): {
  readonly outputText: string;
  readonly sourceMapText?: string;
  readonly diagnostics: readonly CompileDiagnostic[];
} {
  const compilerOptions = emitCompilerOptions(options);
  const originalProgram = ts.createProgram(
    [fileName],
    compilerOptions,
    sourceHost(compilerOptions, fileName, sourceText),
  );
  const originalSourceFile =
    sourceFileInProgram(originalProgram, fileName) ??
    sourceFileFor(sourceText, fileName, { ...options, compilerOptions });
  const fileOptions = {
    ...options,
    compilerOptions,
    sourceFile: originalSourceFile,
    typeChecker: originalProgram.getTypeChecker(),
  };
  const discovered = discoverQueries(sourceText, fileName, fileOptions);
  const transformed = lowerSourceFile(originalSourceFile, discovered, "runtime");
  let outputText = "";
  let sourceMapText: string | undefined;
  const emitted = originalProgram.emit(
    undefined,
    (outputFileName, text) => {
      if (outputFileName.endsWith(".map")) sourceMapText = text;
      else if (!outputFileName.endsWith(".d.ts")) outputText = text;
    },
    undefined,
    false,
    { before: [transformed.transformer] },
  );
  const diagnostics = [
    ...transformed.diagnostics,
    ...(emitted.diagnostics ?? []).map((diagnostic) => {
      const start = diagnostic.start ?? 0;
      const end = start + (diagnostic.length ?? 1);
      return {
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        severity: "error" as const,
        range: { start, end },
      };
    }),
  ];
  if (sourceMapText && transformed.origins) {
    try {
      const sourceMap = JSON.parse(sourceMapText) as Record<string, unknown>;
      sourceMap.x_sqlbraid_origins = transformed.origins;
      sourceMapText = JSON.stringify(sourceMap);
    } catch {}
  }
  return { outputText, ...(sourceMapText ? { sourceMapText } : {}), diagnostics };
}

/** Convert a source offset to zero-based line/character coordinates, clamping out-of-range offsets. */
export function sourcePosition(
  sourceText: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sourceText.length));
  const prefix = sourceText.slice(0, safeOffset);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}
