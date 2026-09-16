import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { cloudflareApi, root, runWrangler } from "./shared.mjs";
import { markPhase, writeReleaseState } from "./release-state.mjs";

export async function rollbackRelease(settings, state, options = {}) {
  const run = options.runWrangler || runWrangler;
  const api = options.cloudflareApi || cloudflareApi;
  const persist = options.writeState || writeReleaseState;
  const reason = options.reason || `Rollback release ${state.releaseId}`;
  const rollbackVps = options.rollbackVps || (() => execFileSync(
    process.execPath,
    [join(root, "scripts", "deploy-vps-status-api.mjs"), "rollback"],
    { cwd: root, env: process.env, stdio: "inherit" },
  ));
  state.rollback.attempted = true;
  state.rollback.actions = [];
  state.rollback.errors = [];
  markPhase(state, "rollback", "running");
  persist(state, options.statePath);

  if (state.changes.pages && state.previous.pagesDeploymentId) {
    try {
      await api(
        settings,
        `/accounts/${settings.accountId}/pages/projects/${encodeURIComponent(state.pagesProjectName)}/deployments/${state.previous.pagesDeploymentId}/rollback`,
        { method: "POST", body: {} },
      );
      state.rollback.actions.push({ component: "pages", target: state.previous.pagesDeploymentId, status: "completed" });
    } catch (error) {
      state.rollback.errors.push(`Pages rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (state.changes.pages) {
    state.rollback.actions.push({ component: "pages", target: null, status: "unavailable", detail: "No previous production deployment" });
    state.rollback.errors.push("Pages rollback is unavailable because no previous production deployment was recorded");
  }

  if (state.changes.worker && state.previous.workerVersionId) {
    try {
      run(["rollback", state.previous.workerVersionId, "--name", state.workerName, "--message", reason, "--yes"]);
      state.rollback.actions.push({ component: "worker", target: state.previous.workerVersionId, status: "completed" });
    } catch (error) {
      state.rollback.errors.push(`Worker rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (state.changes.worker) {
    state.rollback.actions.push({ component: "worker", target: null, status: "unavailable", detail: "No previous Worker version" });
    state.rollback.errors.push("Worker rollback is unavailable because no previous version was recorded");
  }

  if (state.changes.vps) {
    try {
      rollbackVps();
      state.rollback.actions.push({ component: "vps", target: "previous release on each node", status: "completed" });
    } catch (error) {
      state.rollback.errors.push(`VPS rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (state.changes.accessCreated && !state.changes.pages && state.accessApplicationId) {
    try {
      await api(settings, `/accounts/${settings.accountId}/access/apps/${state.accessApplicationId}`, { method: "DELETE" });
      state.rollback.actions.push({ component: "access", target: state.accessApplicationId, status: "deleted-new-application" });
    } catch (error) {
      state.rollback.errors.push(`New Access application cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  state.rollback.completed = state.rollback.errors.length === 0;
  state.status = state.rollback.completed ? "rolled-back" : "rollback-failed";
  markPhase(state, "rollback", state.rollback.completed ? "completed" : "failed", state.rollback.errors.join("; ") || null);
  persist(state, options.statePath);
  return state.rollback;
}
