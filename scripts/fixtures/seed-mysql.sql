-- Sample schema used to capture real MySQL and MariaDB plans for the test
-- fixtures. The same tables and data as seed.sql (PostgreSQL), written so it
-- runs on MySQL 5.7+ and MariaDB 10.4+. Deterministic: re-running produces
-- the same data.
DROP TABLE IF EXISTS order_items, orders, products, customers, seq, digits;

CREATE TABLE digits (d INT NOT NULL);
INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);

-- 1..1,000,000, without recursive CTEs (MySQL 5.7 has none).
CREATE TABLE seq (n INT NOT NULL PRIMARY KEY);
INSERT INTO seq (n)
SELECT 1 + a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + g.d * 100000
FROM digits a, digits b, digits c, digits e, digits f, digits g;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(100) NOT NULL,
  country VARCHAR(2) NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(20) NOT NULL,
  price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  ordered_at DATETIME NOT NULL,
  total DECIMAL(12, 2) NOT NULL DEFAULT 0,
  KEY orders_customer_id_idx (customer_id),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  KEY order_items_order_id_idx (order_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
);

INSERT INTO customers (id, email, country, created_at)
SELECT n, CONCAT('user', n, '@example.com'),
  ELT(1 + (n % 7), 'US', 'GB', 'DE', 'FR', 'BR', 'IN', 'JP'),
  TIMESTAMP('2020-01-01') + INTERVAL (n % 1500) DAY
FROM seq WHERE n <= 20000;

INSERT INTO products (id, name, category, price)
SELECT n, CONCAT('Product ', n),
  ELT(1 + (n % 5), 'books', 'games', 'garden', 'kitchen', 'toys'),
  ROUND(5 + (n * 37 % 500), 2)
FROM seq WHERE n <= 2000;

INSERT INTO orders (id, customer_id, status, ordered_at)
SELECT n, 1 + (n * 7919 % 20000),
  CASE WHEN n % 50 = 0 THEN 'cancelled' WHEN n % 10 = 0 THEN 'pending' ELSE 'shipped' END,
  TIMESTAMP('2021-01-01') + INTERVAL (n % 1000) DAY + INTERVAL (n % 86400) SECOND
FROM seq WHERE n <= 200000;

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price)
SELECT n, 1 + (n % 200000), 1 + (n * 31 % 2000), 1 + (n % 4), ROUND(5 + (n * 37 % 500), 2)
FROM seq WHERE n <= 600000;

UPDATE orders o
JOIN (
  SELECT order_id, SUM(quantity * unit_price) AS total
  FROM order_items
  GROUP BY order_id
) s ON s.order_id = o.id
SET o.total = s.total;

CREATE INDEX orders_ordered_at_idx ON orders (ordered_at);
CREATE INDEX customers_country_idx ON customers (country);

DROP TABLE seq, digits;

ANALYZE TABLE customers, products, orders, order_items;
