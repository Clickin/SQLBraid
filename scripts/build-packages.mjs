import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "dist", "packages");
const packageRoot = join(root, "packages");
const scopeRoot = join(root, "node_modules", "@sqlbraid");
mkdirSync(scopeRoot, { recursive: true });

for (const packageName of readdirSync(packageRoot)) {
  const source = join(sourceRoot, packageName, "src");
  const target = join(packageRoot, packageName, "dist");
  try { readdirSync(source); } catch { continue; }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  for (const executable of ["index.js", "server.js"]) try { chmodSync(join(target, executable), 0o755); } catch { /* package has no executable entry */ }
  const link = join(scopeRoot, packageName);
  try { lstatSync(link); } catch { symlinkSync(join(packageRoot, packageName), link, "dir"); }
}
