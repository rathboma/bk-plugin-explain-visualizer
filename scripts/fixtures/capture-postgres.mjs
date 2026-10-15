// Captures real PostgreSQL plans (JSON and text) into tests/fixtures/postgres.
//
//   docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17
//   psql postgres://postgres:pw@localhost/postgres -f scripts/fixtures/seed.sql
//   PG_URL=postgres://postgres:pw@localhost/postgres node scripts/fixtures/capture-postgres.mjs
//
// FIXTURE_PREFIX names fixtures from other versions (e.g. "pg12-") and CASES
// limits the capture to a comma-separated list of case names.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.PG_URL ?? "postgres://postgres:pw@localhost:5432/postgres";
const outDir = path.resolve(import.meta.dirname, "../../tests/fixtures/postgres");
const prefix = process.env.FIXTURE_PREFIX ?? "";
const only = process.env.CASES?.split(",").map((c) => c.trim());

const cases = [
  {
    name: "seq-scan-filter",
    analyze: true,
    query: `SELECT * FROM customers WHERE email LIKE '%99@example.com'`,
  },
  {
    name: "index-scan",
    analyze: true,
    query: `SELECT * FROM orders WHERE customer_id = 42`,
  },
  {
    name: "hash-join-aggregate",
    analyze: true,
    query: `SELECT c.country, count(*) AS orders, sum(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'pending'
GROUP BY c.country
ORDER BY revenue DESC`,
  },
  {
    name: "hash-join-aggregate-estimate",
    analyze: false,
    query: `SELECT c.country, count(*) AS orders, sum(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'pending'
GROUP BY c.country
ORDER BY revenue DESC`,
  },
  {
    name: "nested-loop-limit",
    analyze: true,
    query: `SELECT o.id, o.total, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.ordered_at DESC
LIMIT 20`,
  },
  {
    name: "parallel-aggregate",
    analyze: true,
    query: `SELECT product_id, sum(quantity) AS units
FROM order_items
GROUP BY product_id`,
  },
  {
    name: "disk-sort",
    analyze: true,
    settings: ["SET work_mem = '64kB'"],
    query: `SELECT * FROM order_items ORDER BY unit_price, id`,
  },
  {
    name: "cte-subplans",
    analyze: true,
    query: `WITH spend AS MATERIALIZED (
  SELECT customer_id, sum(total) AS spent
  FROM orders
  GROUP BY customer_id
)
SELECT c.email, s.spent,
  (SELECT count(*) FROM orders o2 WHERE o2.customer_id = c.id) AS order_count
FROM customers c
JOIN spend s ON s.customer_id = c.id
WHERE c.country = 'JP'
  AND s.spent > (SELECT avg(spent) FROM spend)`,
  },
  {
    name: "bitmap-or",
    analyze: true,
    query: `SELECT * FROM orders
WHERE ordered_at BETWEEN '2022-01-01' AND '2022-01-15' OR customer_id < 50`,
  },
  {
    name: "index-only-scan",
    analyze: true,
    query: `SELECT customer_id FROM orders WHERE customer_id BETWEEN 100 AND 200`,
  },
  {
    name: "union-window",
    analyze: true,
    query: `SELECT id, total, rank() OVER (PARTITION BY status ORDER BY total DESC) AS rnk
FROM orders WHERE customer_id < 100
UNION ALL
SELECT id, total, 0 FROM orders WHERE customer_id > 19950`,
  },
  {
    name: "merge-join",
    analyze: true,
    settings: ["SET enable_hashjoin = off", "SET enable_nestloop = off"],
    query: `SELECT c.id, count(o.id)
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id`,
  },
  {
    name: "never-executed",
    analyze: true,
    query: `SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = -1`,
  },
  {
    name: "verbose-buffers-settings",
    analyze: true,
    verbose: true,
    settings: ["SET random_page_cost = 1.1", "SET work_mem = '8MB'"],
    query: `SELECT p.category, avg(oi.quantity * oi.unit_price)
FROM order_items oi
JOIN products p ON p.id = oi.product_id
WHERE oi.order_id < 5000
GROUP BY p.category`,
  },
  {
    name: "parallel-verbose",
    analyze: true,
    verbose: true,
    warm: true,
    query: `SELECT product_id, sum(quantity) AS units
FROM order_items
WHERE quantity > 1
GROUP BY product_id`,
  },
  {
    name: "update-returning",
    analyze: true,
    modifies: true,
    query: `UPDATE products SET price = price * 1.1 WHERE category = 'toys' RETURNING id, price`,
  },
  {
    name: "insert-select-triggers",
    analyze: true,
    modifies: true,
    query: `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT id, 1, 1, 9.99 FROM orders WHERE customer_id < 20`,
  },
];

function explainSql(c, format) {
  const options = [];
  if (c.analyze) options.push("ANALYZE", "BUFFERS");
  if (c.verbose) options.push("VERBOSE");
  if (c.settings) options.push("SETTINGS");
  options.push(`FORMAT ${format}`);
  return `EXPLAIN (${options.join(", ")}) ${c.query}`;
}

async function run(client, c, format) {
  await client.query("BEGIN");
  try {
    for (const setting of c.settings ?? []) {
      await client.query(setting.replace(/^SET /, "SET LOCAL "));
    }
    const result = await client.query(explainSql(c, format));
    return result.rows.map((row) => row["QUERY PLAN"]);
  } finally {
    await client.query("ROLLBACK");
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const version = (await client.query("SHOW server_version")).rows[0].server_version;
fs.mkdirSync(outDir, { recursive: true });

for (const c of cases.filter((c) => !only || only.includes(c.name))) {
  // Warm the cache so both captures read the same buffers.
  if (c.warm) await run(client, c, "JSON");
  const [json] = await run(client, c, "JSON");
  const text = (await run(client, c, "TEXT")).join("\n");
  const fixture = {
    name: prefix + c.name,
    serverVersion: version,
    analyze: c.analyze,
    modifies: Boolean(c.modifies),
    query: c.query,
    json,
    text,
  };
  fs.writeFileSync(path.join(outDir, `${prefix}${c.name}.json`), JSON.stringify(fixture, null, 2) + "\n");
  console.log(`captured ${prefix}${c.name}`);
}

await client.end();
