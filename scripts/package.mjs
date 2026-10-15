// Builds the release archive Beekeeper Studio's plugin manager installs:
// <id>-<version>.zip with manifest.json and the built files at its root.
// Run `yarn build` first. Needs the `zip` command (preinstalled on CI runners).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

if (manifest.version !== pkg.version) {
  console.error(`manifest.json (${manifest.version}) and package.json (${pkg.version}) versions differ.`);
  process.exit(1);
}
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${manifest.version}`) {
  console.error(`Tag ${tag} does not match manifest version v${manifest.version}.`);
  process.exit(1);
}
if (!fs.existsSync("dist/index.html")) {
  console.error("dist/index.html is missing. Run `yarn build` first.");
  process.exit(1);
}

const archive = `${manifest.id}-${manifest.version}.zip`;
fs.rmSync(archive, { force: true });
execFileSync("zip", ["-r", "-q", archive, "manifest.json", "dist", "README.md", "LICENSE"], { stdio: "inherit" });
console.log(`Created ${archive}`);
