import { defineConfig } from "@sqlbraid/cli/config";

const typePolicy = {
  id: "fixture-policy",
  hash: "fixture-policy-v1",
  mappings: [
    { databaseType: "int4", inputType: "number", outputType: "number", nullable: true },
    { databaseType: "text", inputType: "string", outputType: "string", nullable: true },
  ],
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
};

export default defineConfig({
  codegen: {
    targets: [{
      name: "fixture",
      metadata: "./metadata.json",
      outFile: "./generated/database.ts",
      typePolicy,
    }],
  },
});
