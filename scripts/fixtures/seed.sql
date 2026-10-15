-- Sample schema used to capture real PostgreSQL plans for the test fixtures.
-- Deterministic: re-running produces the same data.
DROP TABLE IF EXISTS order_items, orders, products, customers CASCADE;

SELECT setseed(0.42);

CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL,
  country text NOT NULL,
  created_at timestamp NOT NULL
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10, 2) NOT NULL
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers (id),
  status text NOT NULL,
  ordered_at timestamp NOT NULL,
  total numeric(12, 2) NOT NULL DEFAULT 0
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders (id),
  product_id int NOT NULL REFERENCES products (id),
  quantity int NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

INSERT INTO customers (email, country, created_at)
SELECT
  'user' || g || '@example.com',
  (ARRAY['US', 'GB', 'DE', 'FR', 'BR', 'IN', 'JP'])[1 + (g % 7)],
  timestamp '2020-01-01' + (g % 1500) * interval '1 day'
FROM generate_series(1, 20000) g;

INSERT INTO products (name, category, price)
SELECT
  'Product ' || g,
  (ARRAY['books', 'games', 'garden', 'kitchen', 'toys'])[1 + (g % 5)],
  round((5 + (g * 37 % 500))::numeric, 2)
FROM generate_series(1, 2000) g;

INSERT INTO orders (customer_id, status, ordered_at)
SELECT
  1 + (g * 7919 % 20000),
  CASE WHEN g % 50 = 0 THEN 'cancelled' WHEN g % 10 = 0 THEN 'pending' ELSE 'shipped' END,
  timestamp '2021-01-01' + (g % 1000) * interval '1 day' + (g % 86400) * interval '1 second'
FROM generate_series(1, 200000) g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  1 + (g % 200000),
  1 + (g * 31 % 2000),
  1 + (g % 4),
  round((5 + (g * 37 % 500))::numeric, 2)
FROM generate_series(1, 600000) g;

UPDATE orders o
SET total = s.total
FROM (
  SELECT order_id, sum(quantity * unit_price) AS total
  FROM order_items
  GROUP BY order_id
) s
WHERE s.order_id = o.id;

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_ordered_at_idx ON orders (ordered_at);
CREATE INDEX order_items_order_id_idx ON order_items (order_id);
CREATE INDEX customers_country_idx ON customers (country);

VACUUM ANALYZE customers, products, orders, order_items;
