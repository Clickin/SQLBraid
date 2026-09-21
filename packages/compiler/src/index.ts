export type {
  BindingSite,
  CompileDiagnostic,
  DetailedCheckResult,
  DiscoveredQuery,
  OverlayOptions,
  OverlayQueryType,
  SourceAnalysisResult,
  SourceMap,
  SourceMapOrigin,
  SourceRange,
  TransformSourceOptions,
  TransformSourceResult,
  TypeScriptCheckOptions,
  TypeScriptProjectContext,
  TypeScriptSourceContext,
  VirtualTypeScriptOverlay,
} from "./types.js";

export { discoverQueries } from "./discovery.js";
export { transformSource } from "./source-map.js";
export {
  checkProject,
  checkSource,
  checkSourceDetailed,
  createProjectContext,
  createSourceContext,
  createVirtualOverlay,
  emitSource,
  sourcePosition,
} from "./checking.js";
