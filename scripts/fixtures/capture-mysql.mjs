// Captures real MySQL and MariaDB plans into tests/fixtures/mysql.
//
//   docker run -d --name mysql -e MYSQL_ROOT_PASSWORD=pw -p 3306:3306 mysql:8.4
//   mysql -h127.0.0.1 -uroot -ppw -e "CREATE DATABASE shop"
//   mysql -h127.0.0.1 -uroot -ppw shop < scripts/fixtures/seed-mysql.sql
//   MYSQL_URL=mysql://root:pw@127.0.0.1:3306/shop node scripts/fixtures/capture-mysql.mjs
//
// Every format the server supports is captured for each case: the tree text
// of EXPLAIN FORMAT=TREE and EXPLAIN ANALYZE (MySQL 8.0.16+), FORMAT=JSON
// (version 1 on MySQL, MariaDB's own JSON), MySQL's version 2 JSON (8.3+),
// MariaDB's ANALYZE FORMAT=JSON, and the classic table (with MariaDB's
// tabular ANALYZE). JSON is kept as the text the server sent: MariaDB before
// 11 repeats keys, which JSON.parse would drop.
//
// Fixtures are named after the server, e.g. mysql-8.4-join-aggregate.json;
// FIXTURE_PREFIX overrides that (e.g. "mysql-8.0.17-") and CASES limits the
// capture to a comma-separated list of case names.
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const url = process.env.MYSQL_URL ?? "mysql://root:pw@127.0.0.1:3306/shop";
const outDir = path.resolve(import.meta.dirname, "../../tests/fixtures/mysql");
const only = process.env.CASES?.split(",").map((c) => c.trim());

/**
 * `mysql` and `mariadb` are the minimum versions (major * 10000 + minor * 100
 * + patch) a case needs, when it uses newer syntax.
 */
const cases = [
  {
    name: "seq-scan-filter",
    query: `SELECT * FROM customers WHERE email LIKE '%99@example.com'`,
  },
  {
    name: "index-lookup",
    query: `SELECT * FROM orders WHERE customer_id = 42`,
  },
  {
    name: "join-aggregate",
    query: `SELECT c.country, count(*) AS orders, sum(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'pending'
GROUP BY c.country
ORDER BY revenue DESC`,
  },
  {
    name: "join-limit",
    query: `SELECT o.id, o.total, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.ordered_at DESC
LIMIT 20`,
  },
  {
    name: "hash-join",
    query: `SELECT p.category, count(*) AS items
FROM order_items oi
JOIN products p ON p.price = oi.unit_price
WHERE oi.order_id < 2000
GROUP BY p.category`,
  },
  {
    name: "subqueries",
    query: `SELECT c.email, s.spent,
  (SELECT count(*) FROM orders o2 WHERE o2.customer_id = c.id) AS order_count
FROM customers c
JOIN (
  SELECT customer_id, sum(total) AS spent
  FROM orders
  GROUP BY customer_id
) s ON s.customer_id = c.id
WHERE c.country = 'JP'
  AND s.spent > (SELECT avg(total) * 12 FROM orders)`,
  },
  {
    name: "cte-window",
    mysql: 80000,
    mariadb: 100200,
    query: `WITH ranked AS (
  SELECT id, status, total, rank() OVER (PARTITION BY status ORDER BY total DESC) AS rnk
  FROM orders
  WHERE customer_id < 100
)
SELECT * FROM ranked WHERE rnk <= 3
UNION ALL
SELECT id, status, total, 0 FROM orders WHERE customer_id > 19950`,
  },
  {
    name: "semijoin",
    query: `SELECT * FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE total > 2400)`,
  },
  {
    name: "antijoin",
    query: `SELECT c.id, c.email FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'cancelled')
LIMIT 50`,
  },
  {
    name: "dependent-subquery",
    query: `SELECT p.id, p.name,
  (SELECT max(oi.quantity) FROM order_items oi WHERE oi.unit_price = p.price) AS max_qty
FROM products p
WHERE p.category = 'toys'`,
  },
  {
    name: "index-merge",
    query: `SELECT * FROM orders
WHERE ordered_at BETWEEN '2022-01-01' AND '2022-01-15' OR customer_id < 50`,
  },
  {
    name: "covering-index",
    query: `SELECT customer_id FROM orders WHERE customer_id BETWEEN 100 AND 200`,
  },
  {
    name: "filesort",
    query: `SELECT * FROM order_items ORDER BY unit_price, id LIMIT 100000, 10`,
  },
  {
    name: "distinct-temp",
    query: `SELECT DISTINCT o.status, c.country FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 1000`,
  },
  {
    name: "never-executed",
    query: `SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'lost'`,
  },
  {
    name: "impossible-where",
    query: `SELECT * FROM orders WHERE id = -1`,
  },
  {
    name: "update",
    modifies: true,
    query: `UPDATE products SET price = price * 1.1 WHERE category = 'toys'`,
  },
  {
    name: "update-join",
    modifies: true,
    query: `UPDATE orders o JOIN customers c ON c.id = o.customer_id SET o.status = 'held' WHERE c.country = 'JP' AND o.status = 'pending'`,
  },
  {
    name: "insert-select",
    modifies: true,
    query: `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT id, 1, 1, 9.99 FROM orders WHERE customer_id < 20`,
  },
  {
    name: "delete",
    modifies: true,
    query: `DELETE FROM order_items WHERE order_id < 10`,
  },
];

const conn = await mysql.createConnection({ uri: url, multipleStatements: false, dateStrings: true });
const [[info]] = await conn.query("SELECT VERSION() AS version");
const versionString = String(info.version);
const flavor = /mariadb/i.test(versionString) ? "mariadb" : "mysql";
const [major, minor, patch] = versionString.match(/^(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
const version = major * 10000 + minor * 100 + patch;
const prefix = process.env.FIXTURE_PREFIX || `${flavor}-${major}.${minor}-`;

/** The single value EXPLAIN returns, or undefined when the server refuses. */
async function explain(sql) {
  try {
    const [rows] = await conn.query(sql);
    const values = rows.map((row) => Object.values(row)[0]);
    return values.length === 1 ? values[0] : values;
  } catch (e) {
    console.log(`  ${sql.slice(0, 40)}…: ${e.message}`);
    return undefined;
  }
}

/** The classic EXPLAIN table: column names and rows, as the server returned them. */
async function table(sql) {
  try {
    const [rows, fields] = await conn.query({ sql, rowsAsArray: true });
    return { columns: fields.map((f) => f.name), rows };
  } catch (e) {
    console.log(`  ${sql.slice(0, 40)}…: ${e.message}`);
    return undefined;
  }
}

/** Runs EXPLAIN inside a transaction that is rolled back, so writes leave no trace. */
async function rolledBack(sql, read = explain) {
  await conn.query("START TRANSACTION");
  try {
    return await read(sql);
  } finally {
    await conn.query("ROLLBACK");
  }
}

fs.mkdirSync(outDir, { recursive: true });

for (const c of cases.filter((c) => !only || only.includes(c.name))) {
  const minimum = c[flavor];
  if (minimum && version < minimum) continue;
  const outputs = {};
  const q = c.query;

  if (flavor === "mysql") {
    if (version >= 80016) outputs.tree = await explain(`EXPLAIN FORMAT=TREE ${q}`);
    if (version >= 80018 && !c.modifies) outputs.treeAnalyze = await rolledBack(`EXPLAIN ANALYZE ${q}`);
    if (version >= 80300) await conn.query("SET explain_json_format_version = 1");
    outputs.json = (await explain(`EXPLAIN FORMAT=JSON ${q}`));
    if (version >= 80300) {
      await conn.query("SET explain_json_format_version = 2");
      outputs.jsonV2 = (await explain(`EXPLAIN FORMAT=JSON ${q}`));
      if (!c.modifies) outputs.jsonV2Analyze = (await rolledBack(`EXPLAIN ANALYZE FORMAT=JSON ${q}`));
      await conn.query("SET explain_json_format_version = 1");
    }
    outputs.traditional = await table(`EXPLAIN FORMAT=TRADITIONAL ${q}`);
  } else {
    outputs.json = (await explain(`EXPLAIN FORMAT=JSON ${q}`));
    if (!c.modifies) outputs.jsonAnalyze = (await rolledBack(`ANALYZE FORMAT=JSON ${q}`));
    outputs.traditional = await table(`EXPLAIN ${q}`);
    if (!c.modifies) outputs.traditionalAnalyze = await rolledBack(`ANALYZE ${q}`, table);
  }

  for (const key of Object.keys(outputs)) if (outputs[key] === undefined) delete outputs[key];
  const fixture = {
    name: prefix + c.name,
    flavor,
    serverVersion: versionString,
    version,
    modifies: Boolean(c.modifies),
    query: c.query,
    outputs,
  };
  fs.writeFileSync(path.join(outDir, `${prefix}${c.name}.json`), JSON.stringify(fixture, null, 2) + "\n");
  console.log(`captured ${prefix}${c.name}: ${Object.keys(outputs).join(", ")}`);
}

await conn.end();
