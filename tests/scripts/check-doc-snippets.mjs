#!/usr/bin/env node
// Type-checks every TypeScript and JavaScript code block in the repository
// Markdown against the built workspace packages. Run `pnpm run build` first.
// To exclude a block that is not code (for example, a signature sketch), put
// `<!-- doc-snippet: skip -->` (or `{/* doc-snippet: skip */}` in MDX) on the
// line before the fence.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(testsRoot, "..");
const excluded = new Set(["CHANGELOG.md", "docs/SQLBraid_1.0.0_release_notes.md"]);
const fence = /^```(ts|typescript|tsx|js|javascript|mjs)(?=[ \t\n])[^\n]*\n([\s\S]*?)^```/gmu;
const skipMarker = /(?:<!--|\{\/\*)\s*doc-snippet:\s*skip\b/u;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md", "*.mdx"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file && !excluded.has(file));

const workDir = mkdtempSync(join(testsRoot, ".doc-snippets-"));
const snippets = [];
let skipped = 0;
try {
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(fence)) {
      const before = text.slice(0, match.index).trimEnd().split("\n").at(-1) ?? "";
      if (skipMarker.test(before)) {
        skipped += 1;
        continue;
      }
      const extension = match[1] === "tsx" ? "tsx" : "mts";
      const name = `s${String(snippets.length).padStart(4, "0")}.${extension}`;
      const line = text.slice(0, match.index).split("\n").length;
      writeFileSync(join(workDir, name), `${match[2]}\nexport {};\n`);
      snippets.push({ name, file, line });
    }
  }
  for (const file of ["globals.d.ts", "modules.d.ts"])
    copyFileSync(join(testsRoot, "doc-snippets", file), join(workDir, file));
  writeFileSync(
    join(workDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["ES2023", "DOM"],
        types: ["node"],
        jsx: "react-jsx",
      },
      include: ["*.mts", "*.tsx", "globals.d.ts", "modules.d.ts"],
    }),
  );
  const tsc = createRequire(join(testsRoot, "package.json")).resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", workDir, "--pretty", "false"], { encoding: "utf8" });
  const byName = new Map(snippets.map((snippet) => [snippet.name, snippet]));
  const errors = [];
  for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
    const found = /(s\d+\.(?:mts|tsx))\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line.trim());
    if (!found) continue;
    const snippet = byName.get(found[1]);
    errors.push(`${snippet.file}:${snippet.line + Number(found[2])}:${found[3]} ${found[4]} ${found[5]}`);
  }
  if (result.status !== 0 && errors.length === 0) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    throw new Error("tsc failed without snippet diagnostics.");
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    console.error(`FAIL ${errors.length} type errors in documentation code blocks.`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${snippets.length} documentation code blocks type-check (${skipped} skipped by marker).`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
