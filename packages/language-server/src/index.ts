import { checkSource, createVirtualOverlay, discoverQueries, sourcePosition, type CompileDiagnostic, type OverlayOptions } from "@sqlbraid/compiler";
import type { SchemaSnapshot } from "@sqlbraid/schema";

export interface HoverResult {
  readonly contents: string;
  readonly range: { readonly start: number; readonly end: number };
}

export interface CompletionItem {
  readonly label: string;
  readonly kind: "relation" | "column" | "routine";
  readonly detail?: string;
}

export interface LanguageServiceOptions extends OverlayOptions {
  readonly snapshot?: SchemaSnapshot;
}

export interface SqlBraidLanguageService {
  diagnostics(sourceText: string, fileName: string): readonly CompileDiagnostic[];
  hover(sourceText: string, fileName: string, offset: number): HoverResult | undefined;
  complete(prefix: string): readonly CompletionItem[];
  reload(snapshot: SchemaSnapshot): SqlBraidLanguageService;
}

export function createLanguageService(options: LanguageServiceOptions): SqlBraidLanguageService {
  function diagnostics(sourceText: string, fileName: string): readonly CompileDiagnostic[] {
    return checkSource(sourceText, fileName, options);
  }

  function hover(sourceText: string, fileName: string, offset: number): HoverResult | undefined {
    const overlay = createVirtualOverlay(sourceText, fileName, options);
    const query = overlay.queryTypes.find((candidate) => offset >= candidate.range.start && offset <= candidate.range.end);
    if (!query) return undefined;
    const type = query.resultKind === "command" ? "CommandQuery" : query.resultKind === "call" ? "CallQuery" : "Query";
    return { contents: `${type}<${query.rowType}>`, range: query.range };
  }

  function complete(prefix: string): readonly CompletionItem[] {
    if (!options.snapshot) return [];
    const lower = prefix.toLowerCase();
    const relations = Object.values(options.snapshot.relations).filter((relation) => relation.name.toLowerCase().startsWith(lower)).map((relation) => ({ label: relation.name, kind: "relation" as const, detail: relation.kind }));
    const routines = Object.values(options.snapshot.routines).flat().filter((routine) => routine.name.toLowerCase().startsWith(lower)).map((routine) => ({ label: routine.name, kind: "routine" as const, detail: routine.kind }));
    const columns = Object.values(options.snapshot.relations).flatMap((relation) => relation.columns.filter((column) => column.name.toLowerCase().startsWith(lower)).map((column) => ({ label: column.name, kind: "column" as const, detail: column.tsType ?? column.type })));
    return [...relations, ...columns, ...routines];
  }

  function reload(snapshot: SchemaSnapshot): SqlBraidLanguageService {
    return createLanguageService({ ...options, snapshot });
  }

  return { diagnostics, hover, complete, reload };
}

export { sourcePosition, discoverQueries };
export { startStdioLanguageServer } from "./server.js";
