import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/sqlite";

export default defineConfig({
  codegen: {
    targets: [{
      name: "db",
      metadata: "metadata.json",
      outFile: "generated.ts",
      typePolicy,
    }],
  },
});
