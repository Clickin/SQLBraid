#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { discoverQueries } from "../../compiler/src/index.js";
import { createManifest } from "../../operations/src/index.js";
import type { Query } from "../../core/src/index.js";

function usage(): never {
  console.error("Usage: sqlbraid check --file <path> | sqlbraid manifest --file <path>");
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const fileFlag = argv.indexOf("--file");
  const file = fileFlag >= 0 ? argv[fileFlag + 1] : undefined;
  if (!command || !file) usage();
  const source = await readFile(file, "utf8");
  const discovered = discoverQueries(source, file, { moduleSpecifier: "@sqlbraid/template" });
  if (command === "check") {
    for (const diagnostic of discovered.diagnostics) console.error(`${diagnostic.code}: ${diagnostic.message}`);
    if (discovered.diagnostics.length) process.exitCode = 1;
    return;
  }
  if (command === "manifest") {
    const manifests = discovered.queries.map((query) => createManifest({ ir: query.ir, values: [], render: () => ({ text: "", values: [] }) } as Query, { source: file }));
    process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
    return;
  }
  usage();
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
