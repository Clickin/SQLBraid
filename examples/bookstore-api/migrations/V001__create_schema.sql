CREATE TABLE books (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  customer    TEXT NOT NULL,
  total_cents BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id    BIGINT NOT NULL REFERENCES orders (id),
  book_id     BIGINT NOT NULL REFERENCES books (id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, book_id)
);
