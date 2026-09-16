import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";
import { join } from "node:path";
import { root } from "./control-center/shared.mjs";

const path = join(root, ".env.control-center");
const keys = webpush.generateVAPIDKeys();
let content = readFileSync(path, "utf8");
content = setValue(content, "VAPID_PUBLIC_KEY", keys.publicKey);
content = setValue(content, "VAPID_PRIVATE_KEY", keys.privateKey);
content = setValue(content, "VAPID_SUBJECT", process.env.VAPID_SUBJECT || "mailto:you@example.com");
writeFileSync(path, content, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`VAPID keys configured without disclosure (public=${keys.publicKey.length}, private=${keys.privateKey.length}).`);

function setValue(source, name, value) {
  const line = `${name}='${String(value).replaceAll("'", `'\"'\"'`)}'`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}
