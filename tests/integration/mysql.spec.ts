import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql2 from "mysql2/promise";
import { mysql } from "../../src/engines/mysql";
import type { MysqlServerInfo } from "../../src/engines/mysql/server";
import type { ExplainRequest, QueryResultLike, RunQuery } from "../../src/engines/types";

/**
 * Runs against a real MySQL or MariaDB server when MYSQL_URL is set, e.g.
 *   MYSQL_URL=mysql://root:pw@127.0.0.1:3306/shop yarn test
 *
 * Queries go through a pool configured like Beekeeper Studio's MySQL client:
 * several statements per request, on whichever pooled connection is free.
 */
const url = process.env.MYSQL_URL;

describe.skipIf(!url)("MySQL engine against a live server", () => {
  let pool: mysql2.Pool;
  let server: MysqlServerInfo;
  const run: RunQuery = async (sql) => {
    const [rows, fields] = await pool.query({ sql, rowsAsArray: false });
    // Several statements return a list of results.
    const multiple = Array.isArray(fields) && Array.isArray(fields[0]);
    const results = multiple ? (rows as unknown[]).map((r, i) => [r, (fields as unknown[])[i]]) : [[rows, fields]];
    return results.map(
      ([r, f]): QueryResultLike => ({
        fields: ((f as mysql2.FieldPacket[] | undefined) ?? []).map((field) => ({ name: field.name })),
        rows: Array.isArray(r) ? (r as Record<string, unknown>[]) : [],
      })
    );
  };
  const request = (sql: string, analyze: boolean): ExplainRequest => ({
    statement: mysql.inspect(sql, server),
    analyze,
    options: {},
    server,
  });
  const count = async () => {
    const [rows] = await pool.query("SELECT count(*) AS n FROM explain_it WHERE label = 'changed'");
    return Number((rows as { n: number }[])[0].n);
  };

  beforeAll(async () => {
    pool = mysql2.createPool({ uri: url, multipleStatements: true, dateStrings: true, connectionLimit: 1 });
    await pool.query("DROP TABLE IF EXISTS explain_it");
    await pool.query("CREATE TABLE explain_it (id INT PRIMARY KEY, label VARCHAR(20), grp INT)");
    const values = Array.from({ length: 1000 }, (_, i) => `(${i + 1}, 'row ${i + 1}', ${i % 10})`).join(",");
    await pool.query(`INSERT INTO explain_it VALUES ${values}`);
    await pool.query("ANALYZE TABLE explain_it");
    server = await mysql.loadServerInfo!(run) as MysqlServerInfo;
  });

  afterAll(async () => {
    await pool?.query("DROP TABLE IF EXISTS explain_it");
    await pool?.end();
  });

  it("reads the server", () => {
    expect(["mysql", "mariadb"]).toContain(server.flavor);
    expect(server.version).toBeGreaterThan(50000);
  });

  it("explains a query", async () => {
    const result = await mysql.explain(request("SELECT * FROM explain_it WHERE grp = 3 ORDER BY label", false), run);
    expect(result.plan.analyzed).toBe(false);
    expect(result.plan.nodes.some((n) => n.target === "explain_it")).toBe(true);
  });

  it("analyzes a query where the server can", async () => {
    const statement = mysql.inspect("SELECT * FROM explain_it WHERE id < 10;", server);
    const policy = mysql.analyzePolicy(statement, { server, readOnlyConnection: false });
    if (policy.blocked) {
      expect(server.flavor === "mysql" && server.version! < 80018).toBe(true);
      return;
    }
    const result = await mysql.explain(request("SELECT * FROM explain_it WHERE id < 10;", true), run);
    expect(result.plan.analyzed).toBe(true);
    const scan = result.plan.nodes.find((n) => n.target === "explain_it")!;
    expect(scan.totalActualRows).toBe(9);
    expect(result.plan.root.inclusiveTime).toBeGreaterThan(0);
  });

  it("explains a write without running it, and refuses to analyze it", async () => {
    const sql = "UPDATE explain_it SET label = 'changed' WHERE grp = 1";
    const result = await mysql.explain(request(sql, false), run);
    expect(result.plan.nodes.some((n) => n.kind === "modify" || n.operation === "Update")).toBe(true);
    expect(await count()).toBe(0);
    const policy = mysql.analyzePolicy(mysql.inspect(sql, server), { server, readOnlyConnection: false });
    expect(policy.blocked).toMatch(server.flavor === "mysql" && server.version! < 80018 ? /8\.0\.18/ : /would commit/);
  });

  it("leaves the pooled connection usable after a failed EXPLAIN", async () => {
    await expect(mysql.explain(request("SELECT * FROM no_such_table", false), run)).rejects.toThrow();
    const [rows] = await pool.query("SELECT 1 AS one");
    expect((rows as { one: number }[])[0].one).toBe(1);
  });

  it("follows the session's SQL mode", async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')");
      const [rows] = await conn.query("SELECT VERSION() AS version, @@sql_mode AS sql_mode");
      const row = (rows as { version: string; sql_mode: string }[])[0];
      const { parseServerInfo } = await import("../../src/engines/mysql/server");
      const ansi = parseServerInfo(row.version, row.sql_mode);
      expect(ansi.ansiQuotes).toBe(true);
      expect(mysql.inspect('SELECT "label" FROM explain_it', ansi).modifiesData).toBe(false);
    } finally {
      await conn.query("SET SESSION sql_mode = DEFAULT");
      conn.release();
    }
  });
});
