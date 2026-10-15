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
