import { findProducts, type ProductFilter } from "../lib/products";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const maxPrice = first(params.maxPrice);
  const filter: ProductFilter = {
    q: first(params.q),
    category: first(params.category),
    maxPriceCents: maxPrice === undefined ? undefined : Math.round(Number(maxPrice) * 100),
    inStockOnly: first(params.inStock) === "on",
    sort: first(params.sort) === "price" ? "price" : "name",
  };
  const products = await findProducts(filter);

  return (
    <main>
      <h1>Products</h1>
      <form method="get">
        <input name="q" placeholder="Search" defaultValue={filter.q} />{" "}
        <select name="category" defaultValue={filter.category ?? ""}>
          <option value="">All categories</option>
          <option value="coffee">coffee</option>
          <option value="kitchen">kitchen</option>
        </select>{" "}
        <input name="maxPrice" placeholder="Max price" size={9} defaultValue={maxPrice} />{" "}
        <label>
          <input type="checkbox" name="inStock" defaultChecked={filter.inStockOnly} /> In stock
        </label>{" "}
        <select name="sort" defaultValue={filter.sort}>
          <option value="name">Sort by name</option>
          <option value="price">Sort by price</option>
        </select>{" "}
        <button type="submit">Filter</button>
      </form>
      <ul data-testid="products">
        {products.map((product) => (
          <li key={product.id}>
            {product.name} · {product.category} · ${(Number(product.priceCents) / 100).toFixed(2)} · stock{" "}
            {product.stock}
          </li>
        ))}
      </ul>
      <p>{products.length} products</p>
    </main>
  );
}
