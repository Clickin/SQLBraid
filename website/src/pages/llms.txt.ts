import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { docsBasePath, rawMarkdownUrl } from "../lib/llm-docs";

const sections = [
  ["Getting started", "getting-started/"],
  ["Core concepts", "concepts/"],
  ["Runtime", "runtime/"],
  ["Metadata and code generation", "metadata/"],
  ["Agents and editors", "agents/"],
  ["Reference", "reference/"],
  ["Release", "release/"],
] as const;

function item(entry: CollectionEntry<"docs">, base: string) {
  const description = typeof entry.data.description === "string" && entry.data.description.trim()
    ? `: ${entry.data.description.trim()}`
    : "";
  return `- [${entry.data.title}](${rawMarkdownUrl(entry.id, base)})${description}`;
}

export const GET: APIRoute = async () => {
  const base = docsBasePath();
  const docs = (await getCollection("docs"))
    .filter((entry) => !entry.id.startsWith("ko/"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(docs.map((entry) => [entry.id, entry]));
  const snapshot = base.includes("/v/") ? `release ${base.slice(base.lastIndexOf("/") + 1)}` : "latest documentation";
  const lines = [
    "# SQLBraid",
    "",
    "> SQL-first TypeScript data access. Keep ordinary SQL while SQLBraid provides explicit result contracts, safe value binding, structural SQL helpers, runtime scope, adapters, metadata, code generation, and editor/agent tooling.",
    "",
    `This index belongs to the ${snapshot} snapshot at https://clickin.github.io${base}/. Every documentation link below returns raw Markdown from the same snapshot.`,
    "",
    "Assume ordinary SQL knowledge. Use these documents for SQLBraid-specific APIs, guarantees, limits, and database/driver behavior rather than generic SQL syntax.",
    "",
    "## Start here",
  ];

  for (const id of ["index", "concepts/sql-tags", "concepts/safe-binds", "concepts/structural-fragments", "runtime/transactions", "agents/skill", "reference/support"]) {
    const entry = byId.get(id);
    if (entry) lines.push(item(entry, base));
  }

  const included = new Set(["index"]);
  for (const [, prefix] of sections) {
    for (const entry of docs) if (entry.id.startsWith(prefix)) included.add(entry.id);
  }

  for (const [heading, prefix] of sections) {
    const entries = docs.filter((entry) => entry.id.startsWith(prefix));
    if (entries.length === 0) continue;
    lines.push("", `## ${heading}`);
    for (const entry of entries) lines.push(item(entry, base));
  }

  const optional = docs.filter((entry) => !included.has(entry.id));
  if (optional.length > 0) {
    lines.push("", "## Optional");
    for (const entry of optional) lines.push(item(entry, base));
  }

  lines.push("");
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
