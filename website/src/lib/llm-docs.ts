import type { CollectionEntry } from "astro:content";

const projectRoot = "/SQLBraid/";

export function docsBasePath() {
  return import.meta.env.BASE_URL.replace(/\/+$/u, "");
}

export function rawMarkdownPath(id: string, base = docsBasePath()) {
  return `${base}/${id}.md`;
}

export function rawMarkdownUrl(id: string, base = docsBasePath()) {
  return `https://clickin.github.io${rawMarkdownPath(id, base)}`;
}

function rewriteDestination(destination: string, base: string) {
  if (!destination.startsWith(projectRoot)) return destination;

  const rest = destination.slice(projectRoot.length);
  if (rest.startsWith("latest/") || rest.startsWith("v/")) return destination;

  const match = /^([^?#]*)([?#].*)?$/u.exec(rest);
  if (!match) return destination;
  const route = match[1].replace(/\/+$/u, "");
  const suffix = match[2] ?? "";

  if (!route) return `${base}/index.md${suffix}`;
  if (/\.[^/]+$/u.test(route)) return `${base}/${route}${suffix}`;
  return `${base}/${route}.md${suffix}`;
}

export function rewriteMarkdownDocLinks(source: string, base = docsBasePath()) {
  let fence: "```" | "~~~" | undefined;
  return source.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (!fence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      return line;
    }
    if (fence && trimmed.startsWith(fence)) {
      fence = undefined;
      return line;
    }
    if (fence) return line;

    return line.replace(/(\]\()([^\s)]+)([^)]*\))/gu, (_match, open, destination, close) => {
      return `${open}${rewriteDestination(destination, base)}${close}`;
    });
  }).join("\n");
}

export function renderRawMarkdown(entry: CollectionEntry<"docs">, base = docsBasePath()) {
  const description = typeof entry.data.description === "string" && entry.data.description.trim()
    ? `\n> ${entry.data.description.trim()}\n`
    : "";
  const body = rewriteMarkdownDocLinks(entry.body ?? "", base).trimStart();
  return `# ${entry.data.title}\n${description}\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}
