export { normalizeIdentifier } from "./lexical.js";
import {
  checkSourceDetailed,
  createVirtualOverlay,
  discoverQueries,
  type VirtualTypeScriptOverlay,
} from "@sqlbraid/compiler";
import { AUTHORING_MODULE_CATALOG } from "@sqlbraid/core";
import { SOURCE_FILE_LOADER, type InternalLanguageServiceOptions } from "./internal.js";
import type {
  Cancellation,
  CompletionItem,
  LanguageServiceOptions,
  Location,
  QuerySymbol,
  SqlBraidLanguageService,
  ToolingDiagnostic,
  WorkspaceSymbol,
  HoverResult,
  SignatureResult,
  SourceDocument,
} from "./types.js";
import type { FileAnalysis, GeneratedIndex, MetadataIndex } from "./analysis-types.js";
import type { MetadataSnapshot, RelationSnapshot } from "@sqlbraid/metadata";
import {
  allRelations,
  allRoutines,
  bounded,
  cacheSet,
  completionPrefix,
  identifierKey,
  contentKey,
  lexicalQuery,
  location,
  offsetInStatic,
  lower,
  metadataEvidence,
  queryAt,
  relationForQualifier,
  sourceRange,
  tokenAt,
  unique,
} from "./lexical.js";
import {
  generatedIndexes,
  generatedLocation,
  metadataIndex,
  metadataRange,
  targetMetadataLocation,
} from "./evidence.js";
import {
  columnCandidates,
  columnHover,
  queryHover,
  querySymbols,
  relationCandidates,
  relationHover,
  routineCandidates,
  routineHover,
  routineSignature,
} from "./presentation.js";

const DEFAULT_MAX_ENTRIES = 100;

/** Create a bounded SQL-aware service with per-source/metadata caches and native TypeScript delegation. */
export function createLanguageService(options: LanguageServiceOptions): SqlBraidLanguageService {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const internalOptions = options as InternalLanguageServiceOptions;
  const files = new Map<string, FileAnalysis>();
  const overlays = new Map<string, VirtualTypeScriptOverlay>();
  const diagnosticsCache = new Map<string, readonly ToolingDiagnostic[]>();
  const indexCache = new Map<string, readonly GeneratedIndex[]>();
  const metadataIndexCache = new Map<string, readonly MetadataIndex[]>();
  const modules = unique(
    [
      ...AUTHORING_MODULE_CATALOG.map(({ moduleSpecifier }) => moduleSpecifier),
      ...(options.moduleSpecifiers ?? []),
      ...(options.moduleSpecifier ? [options.moduleSpecifier] : []),
    ],
    (value) => value,
  );
  const semanticOptions: InternalLanguageServiceOptions = { ...options, moduleSpecifiers: modules };
  function analysis(sourceText: string, fileName: string): FileAnalysis {
    const key = contentKey(fileName, sourceText);
    const cached = files.get(key);
    if (cached) return cached;
    const sourceFile = semanticOptions.program?.getSourceFile(fileName);
    const discovered = discoverQueries(sourceText, fileName, {
      ...semanticOptions,
      ...(sourceFile ? { sourceFile } : {}),
    });
    const value: FileAnalysis = {
      sourceText,
      fileName,
      queries: discovered.queries.map((query) => lexicalQuery(query, sourceText, semanticOptions)),
      diagnostics: discovered.diagnostics,
    };
    cacheSet(files, key, value, maxEntries);
    return value;
  }
  function overlay(sourceText: string, fileName: string): VirtualTypeScriptOverlay {
    const key = contentKey(fileName, sourceText);
    const cached = overlays.get(key);
    if (cached) return cached;
    const sourceFile = semanticOptions.program?.getSourceFile(fileName);
    const value = createVirtualOverlay(sourceText, fileName, {
      ...semanticOptions,
      ...(sourceFile ? { sourceFile } : {}),
    });
    cacheSet(overlays, key, value, maxEntries);
    return value;
  }
  function generated(): readonly GeneratedIndex[] {
    const key = (options.targets ?? [])
      .map((target) => `${target.outFile ?? ""}\0${target.generatedSource ?? ""}`)
      .join("\u0001");
    const cached = indexCache.get(key);
    if (cached) return cached;
    const value = generatedIndexes(options);
    cacheSet(indexCache, key, value, maxEntries);
    return value;
  }
  function metadata(): readonly MetadataIndex[] {
    const key = (options.targets ?? [])
      .map((target) => `${target.metadataPath ?? ""}\0${target.metadataSource ?? ""}`)
      .join("\u0001");
    const cached = metadataIndexCache.get(key);
    if (cached) return cached;
    const value = (options.targets ?? [])
      .map(metadataIndex)
      .filter((index): index is MetadataIndex => index !== undefined);
    cacheSet(metadataIndexCache, key, value, maxEntries);
    return value;
  }
  function diagnostics(sourceText: string, fileName: string): readonly ToolingDiagnostic[] {
    const key = contentKey(fileName, sourceText);
    const cached = diagnosticsCache.get(key);
    if (cached) return cached;
    const detailed = checkSourceDetailed(sourceText, fileName, semanticOptions);
    const value: ToolingDiagnostic[] = [
      ...detailed.braidDiagnostics.map((diagnostic) => ({ ...diagnostic, provenance: "braid" as const })),
      // oxlint-disable-next-line no-map-spread -- Attach provenance without mutating compiler-owned diagnostics.
      ...detailed.overlayOnlyDiagnostics.map((diagnostic) => ({ ...diagnostic, provenance: "overlay" as const })),
    ];
    cacheSet(diagnosticsCache, key, value, maxEntries);
    return value;
  }
  function hover(sourceText: string, fileName: string, offset: number): HoverResult | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset);
    if (!lexical) return undefined;
    if (!lexical.mappingReliable) return undefined;
    const generatedEvidence = generated();
    const token = tokenAt(lexical, offset);
    const relationUse = lexical.relationUses.find((use) =>
      use.tokens.some((part) => token && part.start === token.start),
    );
    if (relationUse?.relation && !relationUse.cte)
      return relationHover(
        relationUse.relation,
        sourceRange(token?.sourceStart ?? offset, token?.sourceEnd ?? offset),
        semanticOptions,
      );
    const column = lexical.columnUses.find((use) => token && use.token.start === token.start);
    if (column)
      return columnHover(
        column.owner,
        column.column,
        sourceRange(column.token.sourceStart, column.token.sourceEnd),
        semanticOptions,
        generatedEvidence,
      );
    const routine = lexical.routineUses.find((use) => token && use.token.start === token.start)?.routine;
    if (routine)
      return routineHover(
        routine,
        sourceRange(token?.sourceStart ?? offset, token?.sourceEnd ?? offset),
        semanticOptions,
      );
    const inTag = offset >= lexical.query.range.start && offset < lexical.query.templateRange.start;
    if (inTag || offsetInStatic(lexical, offset)) {
      const contract = overlay(sourceText, fileName).queryTypes.find(
        (candidate) => candidate.range.start === lexical.query.range.start,
      );
      const result = queryHover(lexical, semanticOptions);
      if (contract && contract.rowType !== "unknown" && !lexical.query.declaredRowType)
        return { ...result, contents: result.contents.replace("unknown", contract.rowType) };
      return result;
    }
    return undefined;
  }
  function complete(sourceText: string, fileName: string, offset: number): readonly CompletionItem[] {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return [];
    const logical = lexical.map.findIndex((value) => value >= offset);
    if (logical >= 0 && lexical.code[logical] === false) return [];
    const { prefix, qualified } = completionPrefix(sourceText, offset);
    const cursorToken = lexical.tokens.find(
      (token) => token.kind === "identifier" && token.sourceStart < offset && token.sourceEnd >= offset,
    );
    const before = lexical.tokens.filter((token) => token.sourceEnd <= (cursorToken?.sourceStart ?? offset));
    const previous = before.at(-1);
    const relationContext =
      previous?.kind === "identifier" && ["from", "join", "update", "into"].includes(previous.text.toLowerCase());
    let candidates: CompletionItem[];
    if (relationContext) candidates = relationCandidates(semanticOptions);
    else if (qualified) {
      const qualifier = sourceText.slice(0, offset - prefix.length - 1).match(/[A-Za-z0-9_$\p{L}\p{N}]+$/u)?.[0];
      const owner = qualifier ? relationForQualifier(qualifier, lexical.relationUses, semanticOptions) : undefined;
      if (owner) candidates = columnCandidates(owner);
      else {
        const nextTokenIndex = lexical.tokens.findIndex((candidate) => candidate.sourceStart >= offset);
        const cursorIndex = cursorToken
          ? lexical.tokens.indexOf(cursorToken)
          : nextTokenIndex >= 0
            ? nextTokenIndex
            : lexical.tokens.length;
        const qualifierIndex = cursorIndex - 2;
        const qualifiedRelationContext =
          qualifierIndex > 0 &&
          ["from", "join", "update", "into"].includes(lexical.tokens[qualifierIndex - 1]?.text.toLowerCase() ?? "");
        const relations = qualifier
          ? allRelations(semanticOptions).filter(
              (relation) => relation.namespace === identifierKey(qualifier, lexical.foldIdentifiers),
            )
          : [];
        const routines = qualifier
          ? allRoutines(semanticOptions).filter(
              (routine) => routine.schema === identifierKey(qualifier, lexical.foldIdentifiers),
            )
          : [];
        candidates = qualifiedRelationContext
          ? relations.map((relation) => ({ label: relation.name, kind: "relation" as const, detail: relation.kind }))
          : routines.map((routine) => ({ label: routine.name, kind: "routine" as const, detail: routine.kind }));
      }
    } else
      candidates = [
        ...relationCandidates(semanticOptions),
        ...routineCandidates(semanticOptions),
        ...unique(
          lexical.relationUses
            .map((use) => use.relation)
            .filter((relation): relation is RelationSnapshot => relation !== undefined),
          (relation) => relation.identity,
        ).flatMap(columnCandidates),
      ];
    const wanted = lower(prefix);
    return bounded(
      unique(
        candidates.filter((item) => lower(item.label).startsWith(wanted)),
        (item) => `${item.kind}\0${item.label}`,
      ),
      maxEntries,
    );
  }
  function definition(sourceText: string, fileName: string, offset: number): Location | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return undefined;
    const token = tokenAt(lexical, offset);
    if (!token) return undefined;
    const generatedEvidence = generated();
    const relationUse = lexical.relationUses.find((use) => use.tokens.some((part) => part.start === token.start));
    if (relationUse?.relation && !relationUse.cte)
      return (
        generatedLocation(relationUse.relation, undefined, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(relationUse.relation, undefined, semanticOptions, metadata())
      );
    const column = lexical.columnUses.find((use) => use.token.start === token.start);
    if (column)
      return (
        generatedLocation(column.owner, column.column.name, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(column.owner, column.column.name, semanticOptions, metadata())
      );
    const routine = lexical.routineUses.find((use) => use.token.start === token.start)?.routine;
    if (routine)
      for (const evidence of metadataEvidence(semanticOptions)) {
        const target = evidence.target;
        if (target) {
          const found = metadataRange(metadata(), target, routine.identity, undefined, true);
          if (found) return found;
        }
      }
    return undefined;
  }
  async function references(
    sourceText: string,
    fileName: string,
    offset: number,
    cancellation?: Cancellation,
  ): Promise<readonly Location[]> {
    if (cancellation?.isCancellationRequested) return [];
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return [];
    const token = tokenAt(lexical, offset);
    if (!token) return [];
    const relation = lexical.relationUses.find((use) =>
      use.tokens.some((part) => part.start === token.start),
    )?.relation;
    const column = lexical.columnUses.find((use) => use.token.start === token.start);
    const routine = lexical.routineUses.find((use) => use.token.start === token.start)?.routine;
    if (!relation && !column && !routine) return [];
    const results: Location[] = [];
    const seenFiles = new Set<string>();
    const visit = async (document: SourceDocument): Promise<boolean> => {
      if (cancellation?.isCancellationRequested) return false;
      if (seenFiles.has(document.fileName)) return true;
      seenFiles.add(document.fileName);
      const indexed = analysis(document.sourceText, document.fileName);
      if (cancellation?.isCancellationRequested) return false;
      for (const item of indexed.queries) {
        if (relation)
          for (const use of item.relationUses)
            if (use.relation?.identity === relation.identity && !use.cte) {
              const first = use.tokens[0];
              const last = use.tokens.at(-1) ?? first;
              if (first && last)
                results.push(
                  location(document.fileName, document.sourceText, sourceRange(first.sourceStart, last.sourceEnd)),
                );
            }
        if (routine)
          for (const use of item.routineUses)
            if (use.routine?.identity === routine.identity)
              results.push(
                location(
                  document.fileName,
                  document.sourceText,
                  sourceRange(use.token.sourceStart, use.token.sourceEnd),
                ),
              );
        if (column)
          for (const use of item.columnUses)
            if (use.owner.identity === column.owner.identity && use.column.name === column.column.name)
              results.push(
                location(
                  document.fileName,
                  document.sourceText,
                  sourceRange(use.token.sourceStart, use.token.sourceEnd),
                ),
              );
      }
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      return !cancellation?.isCancellationRequested;
    };
    for (const document of [{ fileName, sourceText }, ...(options.sources ?? [])]) {
      // eslint-disable-next-line no-await-in-loop -- Visit in order and yield between files so cancellation stops further indexing.
      if (!(await visit(document))) return [];
    }
    const sourceLoader = internalOptions[SOURCE_FILE_LOADER];
    for (const sourcePath of internalOptions.sourceFiles ?? []) {
      if (seenFiles.has(sourcePath)) continue;
      if (cancellation?.isCancellationRequested) return [];
      // eslint-disable-next-line no-await-in-loop -- Load only the next file after the prior visit's cancellation check.
      const document = sourceLoader ? await sourceLoader(sourcePath, cancellation) : undefined;
      // eslint-disable-next-line no-await-in-loop -- Finish this visit before advancing the shared reference index.
      if (document && !(await visit(document))) return [];
    }
    return unique(
      results,
      (item) =>
        `${item.uri}\0${item.range.start.line}\0${item.range.start.character}\0${item.range.end.line}\0${item.range.end.character}`,
    );
  }
  function documentSymbols(sourceText: string, fileName: string): readonly QuerySymbol[] {
    return bounded(querySymbols(analysis(sourceText, fileName)), maxEntries);
  }
  function workspaceSymbols(query: string): readonly WorkspaceSymbol[] {
    const wanted = lower(query);
    const result: WorkspaceSymbol[] = [];
    const generatedEvidence = generated();
    for (const relation of allRelations(semanticOptions)) {
      if (!lower(relation.name).includes(wanted) && !lower(relation.identity).includes(wanted)) continue;
      const definitionLocation =
        generatedLocation(relation, undefined, semanticOptions, generatedEvidence) ??
        targetMetadataLocation(relation, undefined, semanticOptions, metadata());
      if (!definitionLocation) continue;
      result.push({ name: relation.name, kind: "relation", location: definitionLocation, detail: relation.identity });
    }
    for (const routine of allRoutines(semanticOptions)) {
      if (!lower(routine.name).includes(wanted) && !lower(routine.identity).includes(wanted)) continue;
      let definitionLocation: Location | undefined;
      for (const evidence of metadataEvidence(semanticOptions))
        if (evidence.target) {
          definitionLocation = metadataRange(metadata(), evidence.target, routine.identity, undefined, true);
          if (definitionLocation) break;
        }
      if (definitionLocation)
        result.push({ name: routine.name, kind: "routine", location: definitionLocation, detail: routine.identity });
    }
    for (const index of generated())
      for (const [name, range] of index.declarations)
        if (lower(name).includes(wanted) && index.target.outFile && index.target.generatedSource)
          result.push({
            name,
            kind: "model",
            location: location(index.target.outFile, index.target.generatedSource, range),
          });
    return bounded(
      unique(result, (item) => `${item.kind}\0${item.name}\0${item.location.uri}`),
      maxEntries,
    );
  }
  function signatureHelp(sourceText: string, fileName: string, offset: number): SignatureResult | undefined {
    const current = analysis(sourceText, fileName);
    const lexical = queryAt(current, offset, true);
    if (!lexical) return undefined;
    for (let useIndex = lexical.routineUses.length - 1; useIndex >= 0; useIndex -= 1) {
      const use = lexical.routineUses[useIndex]!;
      if (offset < use.next.sourceEnd) continue;
      const open = lexical.tokens.findIndex((candidate) => candidate.start === use.next.start);
      if (open < 0) continue;
      let depth = 0;
      let active = 0;
      let closed = false;
      for (let index = open + 1; index < lexical.tokens.length; index += 1) {
        const candidate = lexical.tokens[index]!;
        if (candidate.sourceStart >= offset) break;
        if (candidate.text === "(") depth += 1;
        else if (candidate.text === ")") {
          if (depth === 0) {
            closed = true;
            break;
          }
          depth -= 1;
        } else if (candidate.text === "," && depth === 0) active += 1;
      }
      if (closed) continue;
      return use.routine?.argumentsComplete === true ? routineSignature(use.routine, active) : undefined;
    }
    return undefined;
  }
  function reload(snapshot: MetadataSnapshot): SqlBraidLanguageService {
    return createLanguageService({ ...options, metadata: snapshot });
  }
  return {
    diagnostics,
    hover,
    complete,
    definition,
    references,
    documentSymbols,
    workspaceSymbols,
    signatureHelp,
    reload,
  };
}
