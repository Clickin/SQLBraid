import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function installedPackageVersion(name: string): string {
  let directory = dirname(require.resolve(name));
  for (;;) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { readonly name?: unknown; readonly version?: unknown };
      if (packageJson.name === name && typeof packageJson.version === "string") return packageJson.version;
    } catch {
      // Continue toward the package root when an entry directory has no manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot determine installed version for ${name}.`);
}
