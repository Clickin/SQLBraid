import { createFilter, type Plugin } from "vite";
import {
  sourcePosition,
  transformSource,
  type CompileDiagnostic,
  type TransformSourceOptions,
  type TransformSourceResult,
} from "@sqlbraid/compiler";

export interface SqlBraidViteOptions extends TransformSourceOptions {
  readonly include?: FilterPattern;
  readonly exclude?: FilterPattern;
}

export type FilterPattern = string | RegExp | readonly (string | RegExp)[];

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mts|cts)$/u;
const OUTPUT_PATH = /(?:^|[\\/])(?:node_modules|dist|build|out|\.vite|coverage)(?:[\\/]|$)/u;
const GENERATED_PATH =
  /(?:^|[\\/])(?:generated|__generated__)(?:[\\/]|$)|\.(?:generated|gen)\.(?:ts|tsx|js|jsx|mts|cts)$/u;

function cleanId(id: string): string {
  return id.split(/[?#]/u, 1)[0] ?? id;
}

function shouldTransform(id: string): boolean {
  const fileName = cleanId(id);
  return (
    !fileName.startsWith("\0") &&
    SOURCE_EXTENSION.test(fileName) &&
    !/\.d\.(?:ts|mts|cts)$/u.test(fileName) &&
    !OUTPUT_PATH.test(fileName) &&
    !GENERATED_PATH.test(fileName)
  );
}

function diagnosticMessage(
  fileName: string,
  source: string,
  diagnostic: CompileDiagnostic,
): {
  readonly message: string;
  readonly loc: { readonly file: string; readonly line: number; readonly column: number };
} {
  const position = sourcePosition(source, diagnostic.range.start);
  return {
    message: `${diagnostic.code}: ${diagnostic.message} (${fileName}:${position.line + 1}:${position.character + 1})`,
    loc: { file: fileName, line: position.line + 1, column: position.character },
  };
}

export default function sqlbraid(options: SqlBraidViteOptions = {}): Plugin {
  const filter = createFilter(options.include, options.exclude);
  return {
    name: "sqlbraid",
    enforce: "pre",
    transform(source, id) {
      if (!shouldTransform(id) || !filter(cleanId(id))) return null;
      const result: TransformSourceResult = transformSource(source, cleanId(id), options);
      for (const diagnostic of result.diagnostics) {
        const report = { ...diagnosticMessage(cleanId(id), source, diagnostic), name: "SQLBraidDiagnostic" };
        if (diagnostic.severity === "warning") this.warn(report);
        else this.error(report);
      }
      if (result.code === source) return null;
      return {
        code: result.code,
        map:
          result.map === null
            ? null
            : {
                ...result.map,
                names: [...result.map.names],
                sources: [...result.map.sources],
                sourcesContent: result.map.sourcesContent === undefined ? undefined : [...result.map.sourcesContent],
              },
      };
    },
  };
}

export { transformSource } from "@sqlbraid/compiler";
export type { CompileDiagnostic, SourceMap, TransformSourceOptions, TransformSourceResult } from "@sqlbraid/compiler";
