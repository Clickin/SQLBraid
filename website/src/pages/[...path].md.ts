import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, getEntry } from "astro:content";

const base = import.meta.env.BASE_URL.replace(/\/+$/u, "");

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ params: { path: entry.id } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const id = params.path;
  if (!id) return new Response("Not found\n", { status: 404 });

  const entry = await getEntry("docs", id);
  if (!entry) return new Response("Not found\n", { status: 404 });

  const description = typeof entry.data.description === "string" && entry.data.description.trim()
    ? `\n> ${entry.data.description.trim()}\n`
    : "";
  const body = entry.body.replace(/\/SQLBraid\/(?!latest\/|v\/)/gu, `${base}/`).trimStart();
  const markdown = `# ${entry.data.title}\n${description}\n${body}${body.endsWith("\n") ? "" : "\n"}`;

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
