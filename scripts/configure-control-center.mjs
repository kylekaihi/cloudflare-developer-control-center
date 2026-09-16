import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./control-center/shared.mjs";

const output = join(root, ".env.control-center");
if (existsSync(output)) throw new Error(`${output} already exists; refusing to overwrite it`);

const values = {
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCESS_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
  ACCESS_ALLOWED_EMAILS: "you@example.com",
  DASHBOARD_HOST: "dashboard.example.com",
  D1_DATABASE_NAME: "developer-control-center-monitoring",
  PAGES_PROJECT_NAME: "developer-control-center",
  STATUS_WORKER_URL: "https://developer-control-center-status.your-subdomain.workers.dev",
  STATUS_SERVICE_TOKEN: randomBytes(32).toString("hex"),
  STATUS_SERVICE_TOKEN_PREVIOUS: "",
  STATUS_API_TOKEN: randomBytes(32).toString("hex"),
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  CF_ACCESS_CLIENT_ID: "",
  CF_ACCESS_CLIENT_SECRET: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_SUBJECT: "mailto:you@example.com",
  VPS_DEPLOY_TARGETS: JSON.stringify([
    { name: "vps-1", sshHost: "vps1.example.com", sshPort: 22, sshUser: "root", meshHost: "100.96.0.10" },
    { name: "vps-2", sshHost: "vps2.example.com", sshPort: 22, sshUser: "root", meshHost: "100.96.0.11" },
    { name: "vps-3", sshHost: "vps3.example.com", sshPort: 22, sshUser: "root", meshHost: "100.96.0.12" },
  ]),
  VPS_SSH_IDENTITY_FILE: "",
  VPS_STATUS_SERVICES_JSON: "[]",
  VPS_STATUS_SERVICES_BY_TARGET_JSON: "{}",
  VPS_STATUS_PNL_SUMMARY_JSON: "null",
  STATUS_ENABLE_DOCKER_DISCOVERY: "false",
  AUTO_ROLLBACK_ON_FAILURE: "true",
  SKIP_VPS_DEPLOY: "false",
  POST_DEPLOY_TIMEOUT_SECONDS: "90",
};

const content = Object.entries(values).map(([key, value]) => `${key}=${shellValue(value)}`).join("\n");
writeFileSync(output, `${content}\n`, { mode: 0o600, flag: "wx" });
console.log(`Created ${output} with mode 0600. Secret values were not printed.`);

function shellValue(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
