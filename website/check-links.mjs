import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const output = fileURLToPath(new URL("./dist/", import.meta.url));
const configuredBase = process.env.SQLBRAID_DOCS_BASE?.trim() || "/SQLBraid/latest";
const base = new URL(`https://clickin.github.io${configuredBase.replace(/\/+$/u, "")}/`);
const basePath = base.pathname;
const files = await readdir(output, { recursive: true });
const pages = new Map();
for (const file of files.filter((file) => file.endsWith(".html"))) {
  const text = await readFile(join(output, file), "utf8");
  pages.set(file, { text, ids: new Set([...text.matchAll(/\bid="([^"]*)"/gu)].map((match) => match[1])) });
}
assert.ok(pages.has("index.html"), "Documentation build must produce the homepage.");
assert.ok(pages.has("404.html"), "Documentation build must produce a 404 page.");
assert.ok(await stat(join(output, "llms.txt")).catch(() => undefined), "Documentation build must produce llms.txt.");
const llms = await readFile(join(output, "llms.txt"), "utf8");
assert.ok(llms.includes(`https://clickin.github.io${basePath}`), "llms.txt must target its own documentation snapshot.");

const source = fileURLToPath(new URL("./src/content/docs/", import.meta.url));
for (const file of await readdir(source, { recursive: true })) {
  if (!/\.mdx?$/u.test(file)) continue;
  const route = file.replace(/\.mdx?$/u, "");
  const page = route === "index" || route.endsWith("/index") ? `${route}.html` : route === "404" ? "404.html" : `${route}/index.html`;
  assert.ok(pages.has(page), `Missing built documentation page: ${file}`);
  // docsLoader collapses nested index pages (for example ko/index.md) to the
  // directory content ID, while the root index remains the "index" ID.
  const rawRoute = route !== "index" && route.endsWith("/index") ? route.slice(0, -"/index".length) : route;
  const raw = `${rawRoute}.md`;
  assert.ok(await stat(join(output, raw)).catch(() => undefined), `Missing raw Markdown documentation page: ${raw}`);
}
let checked = 0;
for (const [file, { text }] of pages) {
  const pageUrl = new URL(file.replace(/index\.html$/u, ""), base);
  // Astro emits quoted href attributes; code samples contain escaped markup.
  for (const match of text.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu)) {
    const target = new URL(match[1].replaceAll("&amp;", "&"), pageUrl);
    if (target.origin !== base.origin) continue;
    assert.ok(target.pathname.startsWith(basePath), `${file}: link escapes Pages base: ${target.href}`);
    const relative = decodeURIComponent(target.pathname.slice(basePath.length));
    const destination = relative.endsWith("/") || relative === "" ? `${relative}index.html` : relative;
    const targetFile = await stat(join(output, destination)).catch(() => undefined)
      ?? (!destination.endsWith(".html") ? await stat(join(output, `${destination}/index.html`)).catch(() => undefined) : undefined);
    assert.ok(targetFile, `${file}: missing link ${target.href}`);
    const hash = decodeURIComponent(target.hash.slice(1));
    if (hash && pages.has(destination)) {
      assert.ok(pages.get(destination).ids.has(hash), `${file}: missing anchor ${target.href}`);
    }
    checked += 1;
  }
}
console.info(`PASS ${pages.size} built documentation pages, raw Markdown, llms.txt, and ${checked} local links/anchors`);
