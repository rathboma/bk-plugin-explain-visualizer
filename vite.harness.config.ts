import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import pg from "pg";

/**
 * Runs the harness's queries against PG_URL, returning them in the shape
 * Beekeeper Studio's runQuery uses. Only used by `yarn harness`.
 */
function harnessDatabase(): Plugin {
  let pool: pg.Pool | undefined;
  return {
    name: "harness-database",
    configureServer(server) {
      server.middlewares.use("/__harness/query", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          res.setHeader("Content-Type", "application/json");
          const url = process.env.PG_URL;
          if (!url) {
            res.end(JSON.stringify({ error: { message: "The harness has no database. Start it with PG_URL=postgres://… yarn harness." } }));
            return;
          }
          pool ??= new pg.Pool({ connectionString: url, max: 2 });
          try {
            const { sql } = JSON.parse(body);
            const result = (await pool.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
            const results = (Array.isArray(result) ? result : [result]).map((r) => ({
              fields: (r.fields ?? []).map((f) => ({ id: f.name, name: f.name, dataType: String(f.dataTypeID) })),
              rows: r.rows ?? [],
              rowCount: r.rowCount,
            }));
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
