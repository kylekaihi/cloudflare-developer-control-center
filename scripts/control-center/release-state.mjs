import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { releaseStateDir } from "./shared.mjs";

export function createReleaseState(settings, now = new Date()) {
  const releaseId = now.toISOString().replace(/[:.]/g, "-");
  return {
    schemaVersion: 1,
    releaseId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "preparing",
    dashboardHost: settings.dashboardHost,
    pagesProjectName: settings.pagesProjectName,
    workerName: "developer-control-center-status",
    databaseName: settings.databaseName,
    previous: { workerVersionId: null, pagesDeploymentId: null },
    deployed: { workerVersionId: null, pagesDeploymentId: null },
    changes: { vps: false, worker: false, pages: false, accessCreated: false },
    phases: [],
    rollback: { attempted: false, completed: false, actions: [], errors: [] },
  };
}

export function markPhase(state, name, status = "completed", detail = null) {
  const existing = state.phases.find((phase) => phase.name === name);
  const entry = { name, status, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  if (existing) Object.assign(existing, entry);
  else state.phases.push(entry);
  state.updatedAt = entry.at;
  return state;
}

export function writeReleaseState(state, path = releaseStatePath(state.releaseId)) {
  assertSafeState(state);
  mkdirSync(releaseStateDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  state.updatedAt = new Date().toISOString();
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function readReleaseState(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.schemaVersion !== 1 || !state.releaseId) throw new Error(`Unsupported release state: ${basename(path)}`);
  assertSafeState(state);
  return state;
}

export function releaseStatePath(releaseId) {
  return join(releaseStateDir, `${releaseId}.json`);
}

export function parseWranglerOutput(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function findOutputIdentifier(events, type, keys) {
  const event = [...events].reverse().find((item) => item?.type === type);
  if (!event) return null;
  for (const key of keys) if (typeof event[key] === "string" && event[key]) return event[key];
  return null;
}

function assertSafeState(state) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:token|secret|password|credential)/i.test(key)) throw new Error(`Release state must not contain secret field ${key}`);
      visit(child);
    }
  };
  visit(state);
}
