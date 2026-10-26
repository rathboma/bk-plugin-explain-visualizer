-- Sample schema used to capture real SQLite plans for the test fixtures. The
-- same tables and data as seed.sql (PostgreSQL), written for SQLite 3.8.3+.
-- Deterministic: re-running produces the same data.
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL,
  ordered_at TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL
);

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000)
INSERT INTO customers (id, email, country, created_at)
SELECT n, 'user' || n || '@example.com',
  CASE n % 7 WHEN 0 THEN 'US' WHEN 1 THEN 'GB' WHEN 2 THEN 'DE' WHEN 3 THEN 'FR' WHEN 4 THEN 'BR' WHEN 5 THEN 'IN' ELSE 'JP' END,
  date('2020-01-01', '+' || (n % 1500) || ' days')
FROM seq;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
INSERT INTO products (id, name, category, price)
SELECT n, 'Product ' || n,
  CASE n % 5 WHEN 0 THEN 'books' WHEN 1 THEN 'games' WHEN 2 THEN 'garden' WHEN 3 THEN 'kitchen' ELSE 'toys' END,
  5 + (n * 37 % 500)
FROM seq;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
INSERT INTO orders (id, customer_id, status, ordered_at)
SELECT n, 1 + (n * 7919 % 20000),
  CASE WHEN n % 50 = 0 THEN 'cancelled' WHEN n % 10 = 0 THEN 'pending' ELSE 'shipped' END,
  datetime('2021-01-01', '+' || (n % 1000) || ' days', '+' || (n % 86400) || ' seconds')
FROM seq;

WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 600000)
INSERT INTO order_items (id, order_id, product_id, quantity, unit_price)
SELECT n, 1 + (n % 200000), 1 + (n * 31 % 2000), 1 + (n % 4), 5 + (n * 37 % 500)
FROM seq;

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_ordered_at_idx ON orders (ordered_at);
CREATE INDEX order_items_order_id_idx ON order_items (order_id);
CREATE INDEX customers_country_idx ON customers (country);

UPDATE orders SET total = (
  SELECT sum(quantity * unit_price) FROM order_items WHERE order_items.order_id = orders.id
);

ANALYZE;
