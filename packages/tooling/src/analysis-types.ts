import type { ColumnSnapshot, MetadataSnapshot, RelationSnapshot, RoutineSnapshot } from "@sqlbraid/metadata";
import type { DiscoveredQuery, CompileDiagnostic } from "@sqlbraid/compiler";
import type { ToolingTarget } from "./types.js";

export type Range = { readonly start: number; readonly end: number };
export type MetadataEvidence = { readonly snapshot: MetadataSnapshot; readonly target?: ToolingTarget };

export type LexToken = {
  readonly kind: "identifier" | "punctuation";
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
};
export type RelationUse = {
  readonly tokens: readonly LexToken[];
  readonly text: string;
  readonly relation?: RelationSnapshot;
  readonly cte: boolean;
  readonly alias?: string;
};
export type RoutineUse = { readonly token: LexToken; readonly routine?: RoutineSnapshot; readonly next: LexToken };
export type ColumnUse = {
  readonly owner: RelationSnapshot;
  readonly column: ColumnSnapshot;
  readonly token: LexToken;
  readonly qualified: boolean;
  readonly relationToken: LexToken;
};

export interface LexicalQuery {
  readonly query: DiscoveredQuery;
  readonly text: string;
  readonly map: readonly number[];
  readonly code: readonly boolean[];
  readonly quoted: readonly boolean[];
  readonly mappingReliable: boolean;
  readonly foldIdentifiers: boolean;
  readonly tokens: readonly LexToken[];
  readonly relationUses: readonly RelationUse[];
  readonly routineUses: readonly RoutineUse[];
  readonly columnUses: readonly ColumnUse[];
  readonly staticRanges: readonly Range[];
}
export interface FileAnalysis {
  readonly sourceText: string;
  readonly fileName: string;
  readonly queries: readonly LexicalQuery[];
  readonly diagnostics: readonly CompileDiagnostic[];
}
export interface GeneratedIndex {
  readonly target: ToolingTarget;
  readonly declarations: ReadonlyMap<string, Range>;
  readonly properties: ReadonlyMap<string, Range>;
}
export interface MetadataIndex {
  readonly target: ToolingTarget;
  readonly relations: ReadonlyMap<string, { readonly range: Range; readonly columns: ReadonlyMap<string, Range> }>;
  readonly routines: ReadonlyMap<string, Range>;
}
