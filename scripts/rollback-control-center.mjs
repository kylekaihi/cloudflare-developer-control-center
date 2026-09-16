import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readReleaseState, writeReleaseState } from "./control-center/release-state.mjs";
import { rollbackRelease } from "./control-center/rollback-operations.mjs";
import { readSettings, releaseStateDir } from "./control-center/shared.mjs";

const requested = process.argv[2];
const statePath = requested ? requested : latestReleaseState();
if (!statePath || !existsSync(statePath)) throw new Error("Release state not found. Pass a .control-center/releases/*.json path.");

const settings = readSettings({ requireCloudflare: true });
const state = readReleaseState(statePath);
if (state.rollback?.completed) throw new Error(`Release ${state.releaseId} has already been rolled back`);
if (!state.changes.vps && !state.changes.worker && !state.changes.pages && !state.changes.accessCreated) throw new Error(`Release ${state.releaseId} did not change a rollback-capable component`);

console.log(`Rolling back release ${state.releaseId}`);
const result = await rollbackRelease(settings, state, { statePath, writeState: writeReleaseState });
for (const action of result.actions) console.log(`- ${action.component}: ${action.status}${action.target ? ` -> ${action.target}` : ""}`);
if (result.errors.length) {
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Rollback completed. D1 migrations and retained monitoring data were not reversed.");
}

function latestReleaseState() {
  if (!existsSync(releaseStateDir)) return null;
  const files = readdirSync(releaseStateDir).filter((file) => file.endsWith(".json")).sort().reverse();
  return files[0] ? join(releaseStateDir, files[0]) : null;
}
