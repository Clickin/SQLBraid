import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const output = fileURLToPath(new URL("./dist/", import.meta.url));
const base = new URL("https://clickin.github.io/SQLBraid/");
const files = await readdir(output, { recursive: true });
const pages = new Map();
for (const file of files.filter((file) => file.endsWith(".html"))) {
  const text = await readFile(join(output, file), "utf8");
  pages.set(file, { text, ids: new Set([...text.matchAll(/\bid="([^"]*)"/gu)].map((match) => match[1])) });
}
assert.ok(pages.has("index.html"), "Documentation build must produce the homepage.");
const source = fileURLToPath(new URL("./src/content/docs/", import.meta.url));
for (const file of await readdir(source, { recursive: true })) {
  if (!/\.mdx?$/u.test(file)) continue;
  const route = file.replace(/\.mdx?$/u, "");
  const page = route === "index" ? "index.html" : route === "404" ? "404.html" : `${route}/index.html`;
  assert.ok(pages.has(page), `Missing built documentation page: ${file}`);
}
let checked = 0;
for (const [file, { text }] of pages) {
  const pageUrl = new URL(file.replace(/index\.html$/u, ""), base);
  // Astro emits quoted href attributes; code samples contain escaped markup.
  for (const match of text.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gu)) {
    const target = new URL(match[1].replaceAll("&amp;", "&"), pageUrl);
    if (target.origin !== base.origin) continue;
    assert.ok(target.pathname.startsWith(base.pathname), `${file}: link escapes Pages base: ${target.href}`);
    const relative = decodeURIComponent(target.pathname.slice(base.pathname.length));
    const destination = relative.endsWith("/") || relative === "" ? `${relative}index.html` : relative;
    assert.ok(await stat(join(output, destination)).catch(() => undefined), `${file}: missing link ${target.href}`);
    const hash = decodeURIComponent(target.hash.slice(1));
    if (hash && pages.has(destination)) {
      assert.ok(pages.get(destination).ids.has(hash), `${file}: missing anchor ${target.href}`);
    }
    checked += 1;
  }
}
console.info(`PASS ${pages.size} built documentation pages and ${checked} local links/anchors`);
