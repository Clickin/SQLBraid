import { restock } from "../../../lib/products";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { id, amount } = (await request.json()) as { id: number; amount: number };
  if (!Number.isInteger(id) || !Number.isInteger(amount) || amount <= 0) {
    return Response.json({ error: "id and amount must be integers, and amount must be positive" }, { status: 400 });
  }
  const product = await restock(id, amount);
  return product === undefined ? Response.json({ error: "unknown product" }, { status: 404 }) : Response.json(product);
}
