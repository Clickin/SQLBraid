import { parentPort, workerData } from "node:worker_threads";
import { validateConfig, type CodegenTargetConfig, type SqlBraidConfig } from "./config.js";

function transferConfig(config: SqlBraidConfig): SqlBraidConfig {
  if (!config.codegen) return {};
  return {
    codegen: {
      targets: config.codegen.targets.map((target: CodegenTargetConfig) => ({
        name: target.name,
        metadata: target.metadata,
        outFile: target.outFile,
        typePolicy: {
          id: target.typePolicy.id,
          hash: target.typePolicy.hash,
          mappings: target.typePolicy.mappings.map((mapping) => ({
            databaseType: mapping.databaseType,
            inputType: mapping.inputType,
            outputType: mapping.outputType,
            nullable: mapping.nullable,
            ...(mapping.numeric === undefined ? {} : { numeric: { ...mapping.numeric } }),
          })),
        },
        ...(target.filters ? {
          filters: {
            ...(target.filters.includeNamespaces ? { includeNamespaces: [...target.filters.includeNamespaces] } : {}),
            ...(target.filters.excludeNamespaces ? { excludeNamespaces: [...target.filters.excludeNamespaces] } : {}),
            ...(target.filters.includeRelations ? { includeRelations: [...target.filters.includeRelations] } : {}),
            ...(target.filters.excludeRelations ? { excludeRelations: [...target.filters.excludeRelations] } : {}),
            ...(target.filters.kinds ? { kinds: [...target.filters.kinds] } : {}),
          },
        } : {}),
        ...(target.naming ? {
          naming: {
            ...(target.naming.relations ? { relations: { ...target.naming.relations } } : {}),
            ...(target.naming.suffixes ? { suffixes: { ...target.naming.suffixes } } : {}),
          },
        } : {}),
        ...(target.typeOverrides ? {
          typeOverrides: {
            ...(target.typeOverrides.databaseTypes ? {
              databaseTypes: Object.fromEntries(Object.entries(target.typeOverrides.databaseTypes).map(([databaseType, override]) => [
                databaseType,
                {
                  ...(override.inputType ? { inputType: override.inputType } : {}),
                  ...(override.outputType ? { outputType: override.outputType } : {}),
                },
              ])),
            } : {}),
            ...(target.typeOverrides.columns ? {
              columns: Object.fromEntries(Object.entries(target.typeOverrides.columns).map(([relation, columns]) => [
                relation,
                Object.fromEntries(Object.entries(columns).map(([column, override]) => [
                  column,
                  {
                    ...(override.inputType ? { inputType: override.inputType } : {}),
                    ...(override.outputType ? { outputType: override.outputType } : {}),
                  },
                ])),
              ])),
            } : {}),
          },
        } : {}),
      })),
    },
  };
}

try {
  // Runtime-selected config is the point of this worker; the worker is
  // terminated after one load so Node's ESM cache cannot grow per edit.
  const imported = await import(String((workerData as { readonly url: string }).url));
  const config = imported.default;
  validateConfig(config);
  parentPort?.postMessage({ ok: true, value: transferConfig(config) });
} catch (error) {
  parentPort?.postMessage({ ok: false, configuration: error instanceof Error && error.name === "ConfigurationError", error: error instanceof Error ? error.message : String(error) });
}
