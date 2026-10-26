"""Captures real SQLite plans (EXPLAIN QUERY PLAN rows) into tests/fixtures/sqlite.

    python3 scripts/fixtures/capture-sqlite.py

Python's bundled SQLite is used, so older SQLite versions, whose output
differs, can be captured with an older Python image:

    docker run --rm -v "$PWD:/w" -w /w python:3.6-stretch python3 scripts/fixtures/capture-sqlite.py

Fixtures are named after the SQLite version (FIXTURE_PREFIX overrides it) and
CASES limits the capture to a comma-separated list of case names.
"""
import json
import os
import sqlite3
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "tests", "fixtures", "sqlite")
VERSION = sqlite3.sqlite_version_info

# Cases with a third element need that SQLite version.
CASES = [
    ("full-scan", "SELECT * FROM customers WHERE email LIKE '%99@example.com'"),
    ("index-search", "SELECT * FROM orders WHERE customer_id = 42"),
    ("rowid", "SELECT * FROM orders WHERE id = 5"),
    ("covering-index", "SELECT customer_id FROM orders WHERE customer_id BETWEEN 100 AND 200"),
    ("join-aggregate", """SELECT c.country, count(*) AS orders, sum(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'pending'
GROUP BY c.country
ORDER BY revenue DESC"""),
    ("join-limit", """SELECT o.id, o.total, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.ordered_at DESC
LIMIT 20"""),
    ("automatic-index", """SELECT p.category, count(*) AS items
FROM order_items oi
JOIN products p ON p.price = oi.unit_price
WHERE oi.order_id < 2000
GROUP BY p.category"""),
    ("subqueries", """SELECT c.email, s.spent,
  (SELECT count(*) FROM orders o2 WHERE o2.customer_id = c.id) AS order_count
FROM customers c
JOIN (
  SELECT customer_id, sum(total) AS spent
  FROM orders
  GROUP BY customer_id
) s ON s.customer_id = c.id
WHERE c.country = 'JP'
  AND s.spent > (SELECT avg(total) * 12 FROM orders)"""),
    ("cte-window", """WITH ranked AS (
  SELECT id, status, total, rank() OVER (PARTITION BY status ORDER BY total DESC) AS rnk
  FROM orders
  WHERE customer_id < 100
)
SELECT * FROM ranked WHERE rnk <= 3
UNION ALL
SELECT id, status, total, 0 FROM orders WHERE customer_id > 19950""", (3, 25, 0)),
    ("union", """SELECT customer_id FROM orders WHERE status = 'cancelled'
UNION
SELECT id FROM customers WHERE country = 'JP'"""),
    ("in-subquery", "SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE total > 2400)"),
    ("not-exists", """SELECT c.id, c.email FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'cancelled')
LIMIT 50"""),
    ("correlated-scan", """SELECT p.id, p.name,
  (SELECT max(oi.quantity) FROM order_items oi WHERE oi.unit_price = p.price) AS max_qty
FROM products p
WHERE p.category = 'toys'"""),
    ("multi-index-or", """SELECT * FROM orders
WHERE ordered_at BETWEEN '2022-01-01' AND '2022-01-15' OR customer_id < 50"""),
    ("order-by-temp", "SELECT * FROM order_items ORDER BY unit_price, id LIMIT 10"),
    ("distinct", "SELECT DISTINCT o.status, c.country FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 1000"),
    ("recursive-cte", """WITH RECURSIVE chain(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM chain WHERE n < 10)
SELECT c.id FROM chain JOIN customers c ON c.id = chain.n"""),
    ("update", "UPDATE products SET price = price * 1.1 WHERE category = 'toys'"),
    ("delete", "DELETE FROM order_items WHERE order_id < 10"),
    ("insert-select", """INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT id, 1, 1, 9.99 FROM orders WHERE customer_id < 20"""),
]


def main():
    only = [c.strip() for c in os.environ.get("CASES", "").split(",") if c.strip()]
    prefix = os.environ.get("FIXTURE_PREFIX") or "sqlite-%d.%d-" % VERSION[:2]
    path = os.path.join(tempfile.gettempdir(), "explain-visualizer-%s.db" % sqlite3.sqlite_version)
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path)
    if fresh:
        with open(os.path.join(HERE, "seed-sqlite.sql")) as f:
            conn.executescript(f.read())
        conn.commit()
    if not os.path.isdir(OUT):
        os.makedirs(OUT)

    for case in CASES:
        name, query = case[0], case[1]
        if only and name not in only:
            continue
        if len(case) > 2 and VERSION < case[2]:
            continue
        cursor = conn.execute("EXPLAIN QUERY PLAN " + query)
        fixture = {
            "name": prefix + name,
            "sqliteVersion": sqlite3.sqlite_version,
            "modifies": name in ("update", "delete", "insert-select"),
            "query": query,
            "columns": [d[0] for d in cursor.description],
            "rows": [list(row) for row in cursor.fetchall()],
        }
        with open(os.path.join(OUT, prefix + name + ".json"), "w") as f:
            f.write(json.dumps(fixture, indent=2) + "\n")
        print("captured " + prefix + name)
    conn.close()


main()
