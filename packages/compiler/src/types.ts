import type ts from "typescript";
import type { Dialect, QueryResultKind, TemplateIr } from "@sqlbraid/core";

/** Half-open source range in the original file, preserved through diagnostics and source maps. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** One interpolation expression discovered inside a tagged template. */
export interface BindingSite {
  readonly interpolation: number;
  readonly range: SourceRange;
  readonly expression: string;
}

/**
 * Compiler view of one SQLBraid query. The IR is logical/cooked; raw strings are retained only for native-template mapping.
 */
export interface DiscoveredQuery {
  readonly tagName: string;
  readonly moduleSpecifier: string;
  readonly range: SourceRange;
  readonly templateRange: SourceRange;
  readonly strings: readonly string[];
  readonly rawStrings: readonly string[];
  readonly bindings: readonly BindingSite[];
  readonly ir: TemplateIr;
  readonly mappedRow: boolean;
  readonly resultSchemaExpression?: string;
  readonly resultSchemaRange?: SourceRange;
  readonly declaredRowType?: string;
  readonly declaredResultKind: QueryResultKind;
}

/** Compiler diagnostic mapped back to original source; native TypeScript diagnostics are kept separate. */
export interface CompileDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly range: SourceRange;
}

/** Query discovery plus Braid/template diagnostics for one source file. */
export interface SourceAnalysisResult {
  readonly queries: readonly DiscoveredQuery[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/** Compiler inputs for module/tag discovery, dialect lexical parsing, and optional TypeScript context. */
export interface OverlayOptions {
  readonly moduleSpecifier?: string;
  readonly moduleSpecifiers?: readonly string[];
  readonly tagExport?: string;
  readonly dialect?: Dialect;
  readonly limits?: { readonly maxNestingDepth?: number };
  readonly compilerOptions?: ts.CompilerOptions;
  readonly typeChecker?: ts.TypeChecker;
  readonly sourceFile?: ts.SourceFile;
}

export interface TypeScriptCheckOptions extends OverlayOptions {}

/** Diagnostic partitions returned by detailed checking; overlay-only diagnostics are not native duplicates. */
export interface DetailedCheckResult {
  readonly braidDiagnostics: readonly CompileDiagnostic[];
  readonly nativeTypeScriptDiagnostics: readonly CompileDiagnostic[];
  readonly overlayTypeScriptDiagnostics: readonly CompileDiagnostic[];
  readonly overlayOnlyDiagnostics: readonly CompileDiagnostic[];
}

/** Reusable TypeScript program/checker context for project-aware compiler operations. */
export interface TypeScriptProjectContext {
  readonly projectFile: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

/** Reusable TypeScript program/checker context for one in-memory source file. */
export interface TypeScriptSourceContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

/** Original/generated range correspondence retained in SQLBraid's source-map extension. */
export interface SourceMapOrigin {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

/** Standard source map plus optional SQLBraid origin records for generated template lowering. */
export interface SourceMap {
  readonly version: 3;
  readonly file?: string | null;
  readonly sources: readonly (string | null)[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly x_sqlbraid_origins?: readonly SourceMapOrigin[];
}

export interface TransformSourceOptions extends OverlayOptions {}

/** Output of `transformSource`; the compiler lowers directives but does not transpile TypeScript/JSX. */
export interface TransformSourceResult {
  readonly code: string;
  readonly map: SourceMap | null;
  readonly diagnostics: readonly CompileDiagnostic[];
}

export interface OverlayQueryType {
  readonly range: SourceRange;
  readonly rowType: string;
  readonly resultKind: QueryResultKind;
}

export interface VirtualTypeScriptOverlay {
  readonly sourceFileName: string;
  readonly sourceText: string;
  readonly virtualSourceText: string;
  readonly queryTypes: readonly OverlayQueryType[];
  readonly diagnostics: readonly CompileDiagnostic[];
}
