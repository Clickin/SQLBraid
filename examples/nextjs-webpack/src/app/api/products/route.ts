import { findProducts } from "../../../lib/products";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const maxPrice = params.get("maxPrice");
  const products = await findProducts({
    q: params.get("q") || undefined,
    category: params.get("category") || undefined,
    maxPriceCents: maxPrice ? Math.round(Number(maxPrice) * 100) : undefined,
    inStockOnly: params.get("inStock") === "true",
    sort: params.get("sort") === "price" ? "price" : "name",
  });
  return Response.json(products);
}
