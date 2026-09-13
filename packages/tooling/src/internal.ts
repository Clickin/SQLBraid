import type { Cancellation, LanguageServiceOptions, SourceDocument } from "./types.js";

export const SOURCE_FILE_LOADER = Symbol("@sqlbraid/tooling/source-file-loader");

export type SourceFileLoader = (fileName: string, cancellation?: Cancellation) => Promise<SourceDocument | undefined>;

export interface InternalLanguageServiceOptions extends LanguageServiceOptions {
  readonly sourceFiles?: readonly string[];
  readonly [SOURCE_FILE_LOADER]?: SourceFileLoader;
}
