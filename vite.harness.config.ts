import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import pg from "pg";
import mysql from "mysql2/promise";

interface Result {
  fields: { id: string; name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}

/** BigInts (SQLite integers) don't survive JSON; the app's grid shows them as numbers too. */
const plain = (rows: Record<string, unknown>[]) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));

/**
 * Runs the harness's queries the way Beekeeper Studio's clients do: a pg
 * pool for PostgreSQL, a mysql2 pool with multiple statements for MySQL and
 * MariaDB, and a SQLite file. Only used by `yarn harness`.
 */
function harnessDatabase(): Plugin {
  let pgPool: pg.Pool | undefined;
  const mysqlPools = new Map<string, mysql.Pool>();
  let sqliteDb: import("node:sqlite").DatabaseSync | undefined;

  const postgres = async (sql: string): Promise<Result[]> => {
    const url = process.env.PG_URL;
    if (!url) throw new Error("The harness has no PostgreSQL database. Start it with PG_URL=postgres://… yarn harness.");
    pgPool ??= new pg.Pool({ connectionString: url, max: 2 });
    const result = (await pgPool.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    return (Array.isArray(result) ? result : [result]).map((r) => ({
      fields: (r.fields ?? []).map((f) => ({ id: f.name, name: f.name, dataType: String(f.dataTypeID) })),
      rows: r.rows ?? [],
      rowCount: r.rowCount,
    }));
  };

  const mysqlFamily = async (db: string, sql: string): Promise<Result[]> => {
    const url = db === "mariadb" ? process.env.MARIADB_URL ?? process.env.MYSQL_URL : process.env.MYSQL_URL;
    if (!url) throw new Error(`The harness has no ${db} database. Start it with ${db === "mariadb" ? "MARIADB_URL" : "MYSQL_URL"}=mysql://… yarn harness.`);
    if (!mysqlPools.has(url)) mysqlPools.set(url, mysql.createPool({ uri: url, multipleStatements: true, dateStrings: true, connectionLimit: 2 }));
    const [rows, fields] = await mysqlPools.get(url)!.query(sql);
    const multiple = Array.isArray(fields) && Array.isArray(fields[0]);
    const pairs = multiple ? (rows as unknown[]).map((r, i) => [r, (fields as unknown[])[i]]) : [[rows, fields]];
    return pairs.map(([r, f]) => ({
      fields: ((f as mysql.FieldPacket[] | undefined) ?? []).map((field) => ({ id: field.name, name: field.name })),
      rows: Array.isArray(r) ? (r as Record<string, unknown>[]) : [],
    }));
  };

  /** SQLITE_PATH, or a temporary database seeded from scripts/fixtures/seed-sqlite.sql. */
  const sqlite = async (sql: string): Promise<Result[]> => {
    if (!sqliteDb) {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const file = process.env.SQLITE_PATH ?? path.join(os.tmpdir(), "explain-visualizer-harness.db");
      const fresh = !fs.existsSync(file);
      sqliteDb = new DatabaseSync(file);
      if (fresh) sqliteDb.exec(fs.readFileSync(path.resolve(import.meta.dirname, "scripts/fixtures/seed-sqlite.sql"), "utf8"));
    }
    const statement = sqliteDb.prepare(sql);
    statement.setReadBigInts(true);
    const rows = plain(statement.all() as Record<string, unknown>[]);
    return [{ fields: Object.keys(rows[0] ?? {}).map((name) => ({ id: name, name })), rows }];
  };

  return {
    name: "harness-database",
    configureServer(server) {
      server.middlewares.use("/__harness/query", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          res.setHeader("Content-Type", "application/json");
          try {
            const { sql, db } = JSON.parse(body);
            const results =
              db === "mysql" || db === "mariadb" ? await mysqlFamily(db, sql) : db === "sqlite" ? await sqlite(sql) : await postgres(sql);
            res.end(JSON.stringify({ results }));
          } catch (e) {
            res.end(JSON.stringify({ error: { message: (e as Error).message } }));
          }
        });
      });
    },
  };
}

// Serves the plugin inside dev/harness.html, a page that stands in for
// Beekeeper Studio so the UI can be developed and tested in a plain browser.
export default defineConfig({
  plugins: [vue(), harnessDatabase()],
  server: { open: "/dev/harness.html" },
});
