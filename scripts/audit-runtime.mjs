import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

export const runtimePackages = ["core", "template", "runtime", "postgres", "mysql", "sqlite"];
const allowedNodeImports = new Set(["node:async_hooks", "node:buffer"]);

export async function auditRuntime(packageRoot, directory) {
  let checked = 0;
  for (const name of runtimePackages) {
    const folder = join(packageRoot, name, directory);
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|js|mjs)$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      const text = await readFile(path, "utf8");
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const bufferImport = source.statements.some((node) => ts.isImportDeclaration(node)
        && node.moduleSpecifier.text === "node:buffer"
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.some((item) => item.name.text === "Buffer"));
      function fail(node, reason) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        throw new Error(`${path}:${line + 1}: ${reason}`);
      }
      function visit(node) {
        if (ts.isIdentifier(node)) {
          if (["__dirname", "__filename", "NodeJS", "process"].includes(node.text)) fail(node, `Unreviewed Node assumption: ${node.text}`);
          if (node.text === "Buffer" && (!bufferImport || entry.name.endsWith(".d.ts"))) fail(node, "Global/public Buffer is not portable");
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") fail(node, "CommonJS require in runtime ESM");
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if ((specifier.startsWith("node:") || builtinModules.includes(specifier)) && !allowedNodeImports.has(specifier)) fail(node, `Unreviewed compatibility import: ${specifier}`);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("node:") && !allowedNodeImports.has(node.arguments[0].text)) fail(node, "Unreviewed dynamic Node import");
        ts.forEachChild(node, visit);
      }
      visit(source);
      checked++;
    }
  }
  console.info(`Portability audit: ${checked} ${directory} source/declaration files passed; reviewed node:buffer and node:async_hooks only.`);
}
