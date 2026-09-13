export {
  type Cancellation,
  createLanguageService,
  type CompletionItem,
  type LanguageServiceOptions,
  type Location,
  type HoverResult,
  type QuerySymbol,
  type SignatureResult,
  type SqlBraidLanguageService,
  type SourceDocument,
  type ToolingTarget,
  type ToolingWorkspace,
  type WorkspaceOptions,
  type WorkspaceSymbol,
} from "@sqlbraid/tooling";

export { discoverQueries, sourcePosition } from "@sqlbraid/compiler";
export { startStdioLanguageServer } from "./server.js";
export type { LspStreams, StdioLanguageServerOptions } from "./server.js";
