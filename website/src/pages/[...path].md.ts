import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, getEntry } from "astro:content";
import { renderRawMarkdown } from "../lib/llm-docs";

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ params: { path: entry.id } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) => {
  const id = params.path;
  if (!id) return new Response("Not found\n", { status: 404 });

  const entry = await getEntry("docs", id);
  if (!entry) return new Response("Not found\n", { status: 404 });

  return new Response(renderRawMarkdown(entry), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
