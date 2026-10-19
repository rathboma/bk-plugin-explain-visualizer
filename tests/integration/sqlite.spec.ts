import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { sqlite } from "../../src/engines/sqlite";
import type { QueryResultLike, RunQuery } from "../../src/engines/types";

/**
 * Runs EXPLAIN QUERY PLAN against a real SQLite database through Node's
 * built-in node:sqlite (Node 22.5+), returning integers as BigInts the way
 * Beekeeper Studio's SQLite client does.
 */
type DatabaseSync = import("node:sqlite").DatabaseSync;
let Database: (new (path: string) => DatabaseSync) | undefined;
try {
  Database = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  Database = undefined;
}

describe.skipIf(!Database)("SQLite engine against a real database", () => {
  let db: DatabaseSync;
  const run: RunQuery = async (sql) => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    const rows = statement.all() as Record<string, unknown>[];
    const result: QueryResultLike = { fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows };
    return [result];
  };
  const explain = (sql: string) => sqlite.explain({ statement: sqlite.inspect(sql), analyze: false, options: {} }, run);

  beforeAll(() => {
    db = new Database!(":memory:");
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT, country TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, total REAL);
      CREATE INDEX orders_customer_id_idx ON orders (customer_id);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO customers SELECT i, 'user' || i || '@example.com', 'JP' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
      INSERT INTO orders SELECT i, 1 + i % 1000, 'pending', i * 1.5 FROM n;
      ANALYZE;
    `);
  });

  it("reads the version", async () => {
    const info = await sqlite.loadServerInfo!(run);
    expect(info.versionLabel).toMatch(/^3\.\d+\.\d+$/);
    expect(info.version).toBeGreaterThan(3_024_000);
  });

  it("explains a join", async () => {
    const result = await explain(`SELECT c.email, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id
      WHERE o.total > 100 GROUP BY c.email ORDER BY 2 DESC`);
    expect(result.sql).toMatch(/^EXPLAIN QUERY PLAN SELECT/);
    const targets = result.plan.nodes.map((n) => n.target).filter(Boolean);
    expect(targets).toEqual(expect.arrayContaining(["c", "o"]));
    expect(result.plan.nodes.some((n) => n.index === "orders_customer_id_idx")).toBe(true);
    // The raw text is the sqlite3 shell's, and reads back into the same plan.
    expect(result.raw.startsWith("QUERY PLAN\n")).toBe(true);
    expect(sqlite.parse(result.raw).plan.nodes.map((n) => n.label)).toEqual(result.plan.nodes.map((n) => n.label));
    expect(() => JSON.stringify(result.plan.nodes.map((n) => n.raw))).not.toThrow();
  });

  it("finds an automatic index", async () => {
    const result = await explain("SELECT * FROM orders o JOIN customers c ON c.email = o.status");
    const insights = result.plan.nodes.flatMap((n) => n.insights.map((i) => i.rule));
    expect(insights).toContain("automatic-index");
  });

  it("explains a statement that reads no tables", async () => {
    const result = await explain("INSERT INTO customers (id, email, country) VALUES (5000, 'x', 'JP')");
    expect(result.plan.root.operation).toBe("No steps");
  });

  it("explains a write without running it", async () => {
    await explain("DELETE FROM orders WHERE customer_id = 5");
    const [{ rows }] = await run("SELECT count(*) AS n FROM orders WHERE customer_id = 5");
    expect(Number(rows[0]["n"])).toBe(5);
  });
});
