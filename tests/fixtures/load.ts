import fs from "node:fs";
import path from "node:path";

export interface PostgresFixture {
  name: string;
  serverVersion: string;
  analyze: boolean;
  modifies: boolean;
  query: string;
  json: unknown;
  text: string;
}

const dir = path.resolve(import.meta.dirname, "postgres");
const mysqlDir = path.resolve(import.meta.dirname, "mysql");
const sqliteDir = path.resolve(import.meta.dirname, "sqlite");

const readAll = <T>(folder: string): T[] =>
  fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")));

export function postgresFixtures(): PostgresFixture[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

export function postgresFixture(name: string): PostgresFixture {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

/** A MySQL or MariaDB capture: every format the server had for one statement. */
export interface MysqlFixture {
  name: string;
  flavor: "mysql" | "mariadb";
  serverVersion: string;
  version: number;
  modifies: boolean;
  query: string;
  /** Raw output as the server sent it: tree text, or JSON text... */
  outputs: Partial<Record<"tree" | "treeAnalyze" | "json" | "jsonAnalyze" | "jsonV2" | "jsonV2Analyze", string>> & {
    /** ...and the classic table: column names and rows. */
    traditional?: TableOutput;
    traditionalAnalyze?: TableOutput;
  };
}

export interface TableOutput {
  columns: string[];
  rows: unknown[][];
}

/** A table output the way Beekeeper Studio's runQuery returns it. */
export function tableResult(output: TableOutput) {
  return {
    fields: output.columns.map((name) => ({ name })),
    rows: output.rows.map((row) => Object.fromEntries(output.columns.map((c, i) => [c, row[i]]))),
  };
}

export const mysqlFixtures = (): MysqlFixture[] => readAll<MysqlFixture>(mysqlDir);

export function mysqlFixture(name: string): MysqlFixture {
  return JSON.parse(fs.readFileSync(path.join(mysqlDir, `${name}.json`), "utf8"));
}

/** An EXPLAIN QUERY PLAN capture: the column names and rows SQLite returned. */
export interface SqliteFixture {
  name: string;
  sqliteVersion: string;
  modifies: boolean;
  query: string;
  columns: string[];
  rows: (string | number)[][];
}

export const sqliteFixtures = (): SqliteFixture[] => readAll<SqliteFixture>(sqliteDir);

export function sqliteFixture(name: string): SqliteFixture {
  return JSON.parse(fs.readFileSync(path.join(sqliteDir, `${name}.json`), "utf8"));
}

/** A fixture's rows the way Beekeeper Studio's runQuery returns them. */
export function sqliteResult(fixture: SqliteFixture) {
  return {
    fields: fixture.columns.map((name) => ({ name })),
    rows: fixture.rows.map((row) => Object.fromEntries(fixture.columns.map((c, i) => [c, row[i]]))),
  };
}
