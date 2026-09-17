import { access, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep, win32 } from "node:path";

export const SQLBRAID_CONFIG_FILES = ["sqlbraid.config.mjs", "sqlbraid.config.js", "sqlbraid.config.cjs"] as const;
export const SQLBRAID_DOCUMENT_GLOB = "**/*";
const SQLBRAID_PACKAGE_PREFIX = "@sqlbraid/";

export interface ProjectEvidence {
  readonly kind: "config" | "dependency";
  readonly path: string;
}

export function hasSqlBraidDependency(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packageJson = value as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    if (
      Object.keys(dependencies as Record<string, unknown>).some(
        (name) => name === "sqlbraid" || name.startsWith(SQLBRAID_PACKAGE_PREFIX),
      )
    )
      return true;
  }
  return false;
}

export function isSqlBraidLanguage(languageId: string): boolean {
  return languageId === "typescript" || languageId === "typescriptreact";
}

export function isProjectEvidencePath(filePath: string, rootPath: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/u.test(filePath) || /^[A-Za-z]:[\\/]|^\\\\/u.test(rootPath);
  const relativePath = windows
    ? win32.relative(win32.resolve(rootPath), win32.resolve(filePath))
    : relative(resolve(rootPath), resolve(filePath));
  if (relativePath === ".." || relativePath.startsWith(`..${windows ? win32.sep : sep}`)) return false;
  const fileName = windows ? win32.basename(relativePath) : basename(relativePath);
  return (
    SQLBRAID_CONFIG_FILES.includes(fileName as (typeof SQLBRAID_CONFIG_FILES)[number]) || fileName === "package.json"
  );
}

export async function findProjectEvidence(rootPath: string): Promise<ProjectEvidence | undefined> {
  const root = resolve(rootPath);
  for (const fileName of SQLBRAID_CONFIG_FILES) {
    const path = join(root, fileName);
    try {
      await access(path);
      return { kind: "config", path };
    } catch {
      // Try the next supported config name.
    }
  }

  try {
    const path = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(path, "utf8")) as unknown;
    return hasSqlBraidDependency(packageJson) ? { kind: "dependency", path } : undefined;
  } catch {
    return undefined;
  }
}
