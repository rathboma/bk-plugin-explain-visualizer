import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { postgres } from "../../src/engines/postgres";
import type { ExplainRequest, QueryResultLike, RunQuery } from "../../src/engines/types";

/**
 * Runs against a real server when PG_URL is set, e.g.
 *   PG_URL=postgres://postgres:pw@localhost:5432/postgres yarn test
 *
 * Queries go through a pool exactly like Beekeeper Studio's runQuery: one
 * simple-protocol call per request, on whichever pooled connection is free.
 */
const url = process.env.PG_URL;

describe.skipIf(!url)("PostgreSQL engine against a live server", () => {
  let pool: pg.Pool;
  const run: RunQuery = async (sql) => {
    const result = (await pool.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    const results = Array.isArray(result) ? result : [result];
    return results.map(
      (r): QueryResultLike => ({ fields: (r.fields ?? []).map((f) => ({ name: f.name })), rows: r.rows ?? [] })
    );
  };
  const request = (sql: string, analyze: boolean, server?: ExplainRequest["server"]): ExplainRequest => ({
    statement: postgres.inspect(sql),
    analyze,
    options: { buffers: true, verbose: true, settings: true, wal: true },
    server,
  });
  const count = async () => Number((await pool.query("SELECT count(*) AS n FROM explain_it")).rows[0].n);

  beforeAll(async () => {
    // A single connection makes "the connection is still usable" meaningful.
    pool = new pg.Pool({ connectionString: url, max: 1 });
    await pool.query("DROP TABLE IF EXISTS explain_it");
    await pool.query("CREATE TABLE explain_it (id int PRIMARY KEY, label text)");
    await pool.query("INSERT INTO explain_it SELECT g, 'row ' || g FROM generate_series(1, 1000) g");
  });

  afterAll(async () => {
    await pool?.query("DROP TABLE IF EXISTS explain_it");
    await pool?.end();
  });

  it("reads the server version", async () => {
    const info = await postgres.loadServerInfo!(run);
    expect(info.version).toBeGreaterThan(90000);
  });

  it("explains and analyzes a query", async () => {
    const server = await postgres.loadServerInfo!(run);
    const estimate = await postgres.explain(request("SELECT * FROM explain_it WHERE id < 10", false, server), run);
    expect(estimate.plan.analyzed).toBe(false);

    const actual = await postgres.explain(request("SELECT * FROM explain_it WHERE id < 10;", true, server), run);
    expect(actual.plan.analyzed).toBe(true);
    expect(actual.plan.root.actualRows).toBe(9);
    expect(actual.rawFormat).toBe("json");
  });

  it("rolls back writes made by EXPLAIN ANALYZE", async () => {
    const server = await postgres.loadServerInfo!(run);
    const result = await postgres.explain(request("DELETE FROM explain_it WHERE id <= 500", true, server), run);
    expect(result.sql).toMatch(/ROLLBACK;$/);
    expect(result.plan.root.operation).toBe("Delete");
    expect(result.plan.root.children[0].actualRows).toBe(500);
    expect(await count()).toBe(1000);
  });

  it("rolls back writes made by functions a SELECT calls", async () => {
    await pool.query(
      "CREATE OR REPLACE FUNCTION explain_it_wipe() RETURNS int LANGUAGE sql AS 'DELETE FROM explain_it RETURNING 1'"
    );
    const server = await postgres.loadServerInfo!(run);
    const result = await postgres.explain(request("SELECT explain_it_wipe()", true, server), run);
    expect(result.plan.analyzed).toBe(true);
    expect(await count()).toBe(1000);
    await pool.query("DROP FUNCTION explain_it_wipe()");
  });

  it("leaves the connection usable when the analyzed write fails", async () => {
    const server = await postgres.loadServerInfo!(run);
    await expect(
      postgres.explain(request("INSERT INTO explain_it VALUES (1, 'duplicate')", true, server), run)
    ).rejects.toThrow(/duplicate key/);
    // Same single pooled connection: it must not be stuck in an aborted transaction.
    expect(await count()).toBe(1000);
    const status = await pool.query("SELECT 1 AS ok");
    expect(status.rows[0].ok).toBe(1);
  });

  it("explains parameterized statements with a generic plan", async () => {
    const server = await postgres.loadServerInfo!(run);
    if ((server.version ?? 0) < 160000) return;
    const result = await postgres.explain(request("SELECT * FROM explain_it WHERE id = $1", false, server), run);
    expect(result.sql).toContain("GENERIC_PLAN");
    expect(result.plan.root.kind).toBe("index");
  });
});
