import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function hoverText(hover: vscode.Hover): string {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return contents
    .map((content) => {
      if (typeof content === "string") return content;
      if ("value" in content && typeof content.value === "string") return content.value;
      return JSON.stringify(content);
    })
    .join("\n");
}

function completionItems(value: vscode.CompletionList | readonly vscode.CompletionItem[] | undefined): readonly vscode.CompletionItem[] {
  return value && "items" in value ? value.items : value ?? [];
}

function completionLabels(value: vscode.CompletionList | readonly vscode.CompletionItem[] | undefined): readonly string[] {
  return completionItems(value).map((item) => typeof item.label === "string" ? item.label : item.label.label);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("sqlbraid.sqlbraid-vscode");
  assert.ok(extension, "SQLBraid extension must be discoverable in the extension host");
  assert.equal(extension.extensionPath, process.env.SQLBRAID_EXPECT_EXTENSION_PATH);
  if (process.env.SQLBRAID_VSCODE_SCENARIO === "unrelated") {
    await extension.activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "plain.ts"));
    await vscode.window.showTextDocument(document);
    const position = document.positionAt(document.getText().indexOf("nativeObject.") + "nativeObject.".length);
    await waitFor(async () => {
      const result = await vscode.commands.executeCommand<vscode.CompletionList | readonly vscode.CompletionItem[]>("vscode.executeCompletionItemProvider", document.uri, position);
      return completionLabels(result).includes("nativeField") ? true : undefined;
    }, "native TypeScript in unrelated workspace");
    return;
  }
  await waitFor(async () => extension.isActive ? extension : undefined, "SQLBraid project-scoped activation");

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "Host test must open the SQLBraid fixture workspace");
  const queryPath = join(workspace.uri.fsPath, "query.ts");
  const queryDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(queryPath));
  assert.equal(queryDocument.languageId, "typescript");
  await vscode.window.showTextDocument(queryDocument);

  const scopeDocumentSelector: typeof import("../../src/extension")["scopeDocumentSelector"] =
    require(join(extension.extensionPath, "dist/extension.js")).scopeDocumentSelector;
  const windowsSelector = scopeDocumentSelector([
    { scheme: "file", language: "typescript" },
    { scheme: "file", language: "typescriptreact" },
  ], vscode.Uri.parse("file:///c:/workspace/app"));
  for (const [path, languageId, matches] of [
    ["file:///c:/workspace/app/src/query.ts", "typescript", true],
    ["file:///c:/workspace/app/src/query.tsx", "typescriptreact", true],
    ["file:///c:/workspace/other/query.ts", "typescript", false],
  ] as const) {
    const document = Object.create(queryDocument, {
      uri: { value: vscode.Uri.parse(path) },
      languageId: { value: languageId },
    });
    assert.equal(vscode.languages.match(windowsSelector, document) > 0, matches, path);
  }

  const usersOffset = queryDocument.getText().indexOf("public.users") + "public.".length + 1;
  const usersPosition = queryDocument.positionAt(usersOffset);
  const relationHover = await waitFor(async () => {
    try {
      const hovers = await vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", queryDocument.uri, usersPosition);
      return hovers?.find((hover) => hoverText(hover).includes("Relation public.users"));
    } catch {
      return undefined;
    }
  }, "SQLBraid relation hover");
  assert.ok(hoverText(relationHover).includes("kind: table"));

  const commandIds = await vscode.commands.getCommands(true);
  for (const command of ["sqlbraid.generateModels", "sqlbraid.checkGeneratedModels", "sqlbraid.reloadProject"]) {
    assert.ok(commandIds.includes(command), `Missing command ${command}`);
  }

  const generatedPath = join(workspace.uri.fsPath, "generated", "database.ts");
  await vscode.commands.executeCommand("sqlbraid.generateModels");
  await waitFor(async () => {
    try {
      return await readFile(generatedPath, "utf8");
    } catch {
      return undefined;
    }
  }, "generated model output");
  const generatedSource = await readFile(generatedPath, "utf8");
  assert.match(generatedSource, /export interface UsersRow/u);
  const generatedRealPath = await realpath(generatedPath);

  const definition = await waitFor(async () => {
    try {
      const locations = await vscode.commands.executeCommand<readonly vscode.Location[]>("vscode.executeDefinitionProvider", queryDocument.uri, usersPosition);
      for (const location of locations ?? []) {
        if (await realpath(location.uri.fsPath) === generatedRealPath) return location;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }, "generated model definition");
  assert.equal(await realpath(definition.uri.fsPath), generatedRealPath);

  const beforeCheck = (await stat(generatedPath)).mtimeMs;
  await vscode.commands.executeCommand("sqlbraid.checkGeneratedModels");
  const afterCheck = (await stat(generatedPath)).mtimeMs;
  assert.equal(afterCheck, beforeCheck, "codegen --check must not rewrite generated models");

  await vscode.commands.executeCommand("sqlbraid.reloadProject");
  await waitFor(async () => {
    try {
      const hovers = await vscode.commands.executeCommand<readonly vscode.Hover[]>("vscode.executeHoverProvider", queryDocument.uri, usersPosition);
      return hovers?.find((hover) => hoverText(hover).includes("Relation public.users"));
    } catch {
      return undefined;
    }
  }, "SQLBraid hover after project reload");

  const coexistPath = join(workspace.uri.fsPath, "coexist.ts");
  await writeFile(coexistPath, [
    "const nativeObject = { nativeField: 1 };",
    "nativeObject.nativeField;",
    "const invalidNumber: number = \"native TypeScript diagnostics remain visible\";",
  ].join("\n"));
  const coexistDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(coexistPath));
  await vscode.window.showTextDocument(coexistDocument);
  const nativeCompletionPosition = coexistDocument.positionAt(coexistDocument.getText().indexOf("nativeObject.") + "nativeObject.".length);
  const nativeCompletion = await waitFor(async () => {
    const value = await vscode.commands.executeCommand<vscode.CompletionList | readonly vscode.CompletionItem[]>(
      "vscode.executeCompletionItemProvider",
      coexistDocument.uri,
      nativeCompletionPosition,
    );
    return completionLabels(value).includes("nativeField") ? value : undefined;
  }, "native TypeScript completion");
  assert.ok(completionLabels(nativeCompletion).includes("nativeField"));
  const diagnostics = await waitFor(async () => {
    const value = vscode.languages.getDiagnostics(coexistDocument.uri);
    return value.some((diagnostic) => diagnostic.source === "ts" && diagnostic.code === 2322) ? value : undefined;
  }, "native TypeScript diagnostics");
  assert.ok(diagnostics.some((diagnostic) => diagnostic.source === "ts" && diagnostic.code === 2322));

  const sqlCompletionPath = join(workspace.uri.fsPath, "sql-completion.ts");
  const sqlCompletionSource = [
    'import { sql } from "@sqlbraid/template";',
    "export const completionQuery = sql`SELECT * FROM public.`;",
    "",
  ].join("\n");
  await writeFile(sqlCompletionPath, sqlCompletionSource);
  const sqlCompletionDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(sqlCompletionPath));
  const sqlCompletionPosition = sqlCompletionDocument.positionAt(sqlCompletionSource.indexOf("public.") + "public.".length);
  const isUsersRelation = (item: vscode.CompletionItem): boolean =>
    item.label === "users" && item.kind === vscode.CompletionItemKind.Class && item.detail === "table";
  const sqlCompletion = await waitFor(async () => {
    const value = await vscode.commands.executeCommand<vscode.CompletionList | readonly vscode.CompletionItem[]>(
      "vscode.executeCompletionItemProvider",
      sqlCompletionDocument.uri,
      sqlCompletionPosition,
    );
    return completionItems(value).some(isUsersRelation) ? value : undefined;
  }, "SQL completion");
  assert.ok(completionItems(sqlCompletion).some(isUsersRelation));

  const unrelatedPath = process.env.SQLBRAID_OUTSIDE_PATH;
  assert.ok(unrelatedPath);
  await mkdir(unrelatedPath, { recursive: true });
  await writeFile(join(unrelatedPath, "plain.ts"), sqlCompletionSource);
  const unrelatedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(unrelatedPath, "plain.ts")));
  const unrelatedCompletion = await vscode.commands.executeCommand<vscode.CompletionList | readonly vscode.CompletionItem[]>(
    "vscode.executeCompletionItemProvider",
    unrelatedDocument.uri,
    unrelatedDocument.positionAt(sqlCompletionSource.indexOf("public.") + "public.".length),
  );
  assert.ok(!completionItems(unrelatedCompletion).some(isUsersRelation), "SQLBraid must not provide workspace evidence to an outside document");
}
