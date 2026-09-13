import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("sqlbraid.sqlbraid-vscode");
  assert.ok(extension, "SQLBraid extension must be discoverable in the extension host");
  await waitFor(async () => extension.isActive ? extension : undefined, "SQLBraid project-scoped activation");

  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "Host test must open the SQLBraid fixture workspace");
  const queryPath = join(workspace.uri.fsPath, "query.ts");
  const queryDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(queryPath));
  assert.equal(queryDocument.languageId, "typescript");
  await vscode.window.showTextDocument(queryDocument);

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

  const definition = await waitFor(async () => {
    try {
      const locations = await vscode.commands.executeCommand<readonly vscode.Location[]>("vscode.executeDefinitionProvider", queryDocument.uri, usersPosition);
      return locations?.find((location) => location.uri.fsPath === generatedPath);
    } catch {
      return undefined;
    }
  }, "generated model definition");
  assert.equal(definition.uri.fsPath, generatedPath);

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
}
