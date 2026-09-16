import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { root } from "./control-center/shared.mjs";

const roots = ["scripts", "functions", "worker/status-api", "status-api"];
const files = roots.flatMap((directory) => walk(join(root, directory)))
  .filter((path) => [".js", ".mjs"].includes(extname(path)))
  .sort();

for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
execFileSync("bash", ["-n", join(root, "scripts", "vps-status-api.sh")], { stdio: "pipe" });
console.log(`Runtime syntax check passed (${files.length} JavaScript modules + 1 Bash installer).`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
