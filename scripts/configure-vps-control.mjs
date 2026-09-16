import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./control-center/shared.mjs";

const path = join(root, ".env.control-center");
const existing = readFileSync(path, "utf8");
const actions = {
  "vps-1": [],
  "vps-2": [],
  "vps-3": [],
};

let output = upsert(existing, "VPS_CONTROL_TOKEN", randomBytes(32).toString("base64url"), false);
output = upsert(output, "VPS_CONTROL_ACTIONS_BY_TARGET_JSON", JSON.stringify(actions), true);
writeFileSync(path, output, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`VPS control configured with ${Object.values(actions).flat().length} allowlisted non-trading services; secret value was not printed.`);

function upsert(content, key, value, preserveExisting) {
  const line = content.split("\n").find((entry) => entry.startsWith(`${key}=`));
  if (preserveExisting && line) return content;
  if (!preserveExisting && line && line.slice(key.length + 1).trim()) return content;
  const encoded = `'${String(value).replaceAll("'", `'"'"'`)}'`;
  return line ? content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${encoded}`) : `${content.trimEnd()}\n${key}=${encoded}\n`;
}
