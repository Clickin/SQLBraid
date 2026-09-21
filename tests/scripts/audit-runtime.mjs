import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

export const runtimePackages = [
  "core",
  "template",
  "runtime",
  "postgres",
  "mysql",
  "mariadb",
  "sqlite",
  "oracle",
  "mssql",
  "bun-sql",
];
export const runtimeAuditPackages = [...runtimePackages, "opentelemetry"];
const allowedNodeImports = new Set(["node:async_hooks", "node:buffer"]);
const nodeOnlySubpaths = new Map([
  ["oracle", new Set(["oracledb"])],
  ["mssql", new Set(["tedious", "inspector"])],
  ["mariadb", new Set(["mariadb", "inspector"])],
  ["sqlite", new Set(["better-sqlite3"])],
]);

export async function auditRuntime(
  packageRoot,
  directory,
  { excludedSubpaths = nodeOnlySubpaths, packages = runtimeAuditPackages } = {},
) {
  let checked = 0;
  for (const name of packages) {
    const folder = join(packageRoot, name, directory);
    const manifest = JSON.parse(await readFile(join(packageRoot, name, "package.json"), "utf8"));
    const nodeOnlyDriver =
      name === "oracle"
        ? "oracledb"
        : name === "mssql"
          ? "tedious"
          : name === "mariadb"
            ? "mariadb"
            : name === "sqlite"
              ? "better-sqlite3"
              : undefined;
    if (
      nodeOnlyDriver &&
      [manifest.dependencies, manifest.optionalDependencies].some((dependencies) => dependencies?.[nodeOnlyDriver])
    ) {
      throw new Error(
        `${manifest.name} portable root has a production dependency on Node-only driver ${nodeOnlyDriver}.`,
      );
    }
    const excluded = excludedSubpaths.get(name) ?? new Set();
    function isExcludedPath(relativePath) {
      const withoutExtension = relativePath.replace(/\.(?:d\.)?(?:ts|js|mjs)$/u, "");
      return [...excluded].some(
        (subpath) =>
          withoutExtension === subpath ||
          withoutExtension.startsWith(`${subpath}/`) ||
          withoutExtension.startsWith(`${subpath}-`),
      );
    }
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|js|mjs)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      const relativePath = path.slice(folder.length + 1).replaceAll("\\", "/");
      if (isExcludedPath(relativePath)) continue;
      const text = await readFile(path, "utf8");
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const bufferImport = source.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.text === "node:buffer" &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some((item) => item.name.text === "Buffer"),
      );
      function fail(node, reason) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        throw new Error(`${path}:${line + 1}: ${reason}`);
      }
      function visit(node) {
        if (ts.isIdentifier(node)) {
          if (["__dirname", "__filename", "NodeJS", "process"].includes(node.text))
            fail(node, `Unreviewed Node assumption: ${node.text}`);
          if (node.text === "Buffer" && (!bufferImport || entry.name.endsWith(".d.ts")))
            fail(node, "Global/public Buffer is not portable");
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require")
          fail(node, "CommonJS require in runtime ESM");
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith("./")) {
            const relativeImport = specifier.slice(2).replace(/\.(?:[cm]?js|ts)$/u, "");
            if (isExcludedPath(relativeImport)) {
              fail(node, `Portable ${name} root dependency graph reaches excluded Node-only subpath ${relativeImport}`);
            }
          }
          if (nodeOnlyDriver && (specifier === nodeOnlyDriver || specifier.startsWith(`${nodeOnlyDriver}/`))) {
            fail(node, `Node-only driver dependency leaked into portable ${name} runtime`);
          }
          if (
            (specifier.startsWith("node:") || builtinModules.includes(specifier)) &&
            !allowedNodeImports.has(specifier)
          )
            fail(node, `Unreviewed compatibility import: ${specifier}`);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text.startsWith("node:") &&
          !allowedNodeImports.has(node.arguments[0].text)
        )
          fail(node, "Unreviewed dynamic Node import");
        ts.forEachChild(node, visit);
      }
      visit(source);
      checked++;
    }
  }
  console.info(
    `Portability audit: ${checked} ${directory} source/declaration files passed; reviewed node:buffer and node:async_hooks only; explicitly excluded Node-only Oracle oracledb, MSSQL tedious/inspector, and SQLite better-sqlite3 driver subpaths; Bun.SQL remains structural and runtime-neutral until a Bun client is supplied.`,
  );
}
