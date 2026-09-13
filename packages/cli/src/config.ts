import type {
  CodegenNamingOptions,
  CodegenRelationFilter,
  CodegenTypeOverrides,
  CodegenOptions,
} from "@sqlbraid/codegen";

export interface CodegenTargetConfig {
  readonly name: string;
  readonly metadata: string;
  readonly outFile: string;
  readonly typePolicy: CodegenOptions["typePolicy"];
  readonly filters?: CodegenRelationFilter;
  readonly naming?: CodegenNamingOptions;
  readonly typeOverrides?: CodegenTypeOverrides;
}

export interface SqlBraidConfig {
  readonly codegen?: {
    readonly targets: readonly CodegenTargetConfig[];
  };
}

export function defineConfig(config: SqlBraidConfig): SqlBraidConfig {
  return config;
}
