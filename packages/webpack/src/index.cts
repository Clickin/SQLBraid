import type { SourceMap, TransformSourceOptions } from "@sqlbraid/compiler";

interface LoaderContext {
  readonly resourcePath: string;
  getOptions(): unknown;
  cacheable(flag: boolean): void;
  async(): (error: Error | null, code?: string, map?: string | SourceMap | null) => void;
  emitError(error: Error): void;
  emitWarning(warning: Error): void;
}

type Options = Pick<TransformSourceOptions, "moduleSpecifiers" | "tagExport">;

function optionsFrom(value: unknown): Options {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SQLBraid loader options must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "moduleSpecifiers" && key !== "tagExport")
      throw new TypeError(`Unknown SQLBraid loader option: ${key}`);
  }
  let moduleSpecifiers: string[] | undefined;
  if ("moduleSpecifiers" in value) {
    if (
      !Array.isArray(value.moduleSpecifiers) ||
      !value.moduleSpecifiers.every((item: unknown) => typeof item === "string" && item.length > 0)
    ) {
      throw new TypeError("moduleSpecifiers must be an array of nonempty strings");
    }
    moduleSpecifiers = value.moduleSpecifiers;
  }
  let tagExport: string | undefined;
  if ("tagExport" in value) {
    if (typeof value.tagExport !== "string" || value.tagExport.length === 0)
      throw new TypeError("tagExport must be a nonempty string");
    tagExport = value.tagExport;
  }
  return { moduleSpecifiers, tagExport };
}

function sqlbraid(this: LoaderContext, source: string, inputMap?: string | SourceMap | null): void {
  this.cacheable(true);
  const callback = this.async();
  void (async () => {
    const options = optionsFrom(this.getOptions());
    const [{ transformSource, sourcePosition }, { default: remapping }, { TraceMap, originalPositionFor, encodedMap }] =
      await Promise.all([
        import("@sqlbraid/compiler"),
        import("@jridgewell/remapping"),
        import("@jridgewell/trace-mapping"),
      ]);
    const previousMap =
      inputMap == null ? undefined : typeof inputMap === "string" ? inputMap : JSON.stringify(inputMap);
    const upstream = previousMap ? new TraceMap(previousMap) : undefined;
    const result = transformSource(source, this.resourcePath, options);
    let failed = false;
    for (const diagnostic of result.diagnostics) {
      const position = sourcePosition(source, diagnostic.range.start);
      const original =
        upstream && originalPositionFor(upstream, { line: position.line + 1, column: position.character });
      const file = original?.source ?? this.resourcePath;
      const line = original?.line ?? position.line + 1;
      const column = original?.column ?? position.character;
      const error = Object.assign(
        new Error(`${diagnostic.code}: ${diagnostic.message} (${file}:${line}:${column + 1})`),
        {
          name: "SQLBraidDiagnostic",
          file,
          loc: { line, column },
        },
      );
      if (diagnostic.severity === "warning") this.emitWarning(error);
      else {
        this.emitError(error);
        failed = true;
      }
    }
    if (failed) throw new Error("SQLBraid compilation failed");
    if (result.map === null) {
      callback(null, result.code, typeof inputMap === "string" && upstream ? encodedMap(upstream) : inputMap);
      return;
    }
    const map = previousMap ? remapping([JSON.stringify(result.map), previousMap], () => null) : result.map;
    if (typeof map.mappings !== "string") throw new Error("SQLBraid expected an encoded source map");
    callback(null, result.code, { ...map, mappings: map.mappings });
  })().catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
}

export = sqlbraid;
