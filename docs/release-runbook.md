# Developer Control Center release runbook

## 1. Prepare authorization

Use Node.js 22.12 or newer. The preflight rejects older runtimes before deployment.

Copy `infra/control-center.env.example` to `.env.control-center`, fill the values, and keep the file outside Git. The Cloudflare API token requires Account Settings Read, Access Apps and Policies Write, D1 Edit, Workers Scripts Edit, and Pages Edit.

When Wrangler OAuth is used for Workers, Pages, and D1 but lacks Access scope, set a separate least-privilege `CLOUDFLARE_ACCESS_API_TOKEN` with Account → Access: Apps and Policies → Edit. The deployment uses it only for `/access/` API requests.

`VPS_DEPLOY_TARGETS` must contain at least one SSH endpoint. Each `meshHost` must match one address in the Worker's `STATUS_SERVICE_HOSTS`. Use an SSH key and non-interactive sudo when the SSH user is not root.

## 2. Run the gate

```sh
set -a
. ./.env.control-center
set +a
npm run preflight:deploy
```

This validates local configuration and secrets hygiene, executes all tests, builds the site, checks D1 migrations for destructive statements, and performs a Worker dry run. It does not change remote state.

GitHub Actions runs the same secret-free gate on pushes and pull requests. It has read-only repository permissions and no deployment credentials.

## 3. Deploy once

```sh
npm run deploy:control-center
```

The deployment sequence is:

1. Export a pre-change recovery backup and save current Worker/Pages targets.
2. Upgrade the status API on all configured VPS nodes.
3. Reuse or create D1 and apply backward-compatible migrations.
4. Reuse or create the Access app and allow policy.
5. Configure secrets and deploy Worker, Cron, Pages Function, and static PWA.
6. Verify Access, Worker health, Cron, Mesh reachability, D1 samples, Pages binding, and PWA assets.

If a versioned step or acceptance check fails, automatic rollback runs by default. Set `AUTO_ROLLBACK_ON_FAILURE=false` only when manually investigating a failed deployment.

## 4. Verify again

```sh
npm run verify:control-center
npm run vps:status-api -- healthcheck
```

The Access service token is optional when `STATUS_API_TOKEN` is available, but it is recommended because it allows the verifier to exercise the complete Access → Pages Function → Worker path and protected PWA assets.

## 5. Manual rollback

```sh
npm run rollback:control-center
```

To choose an older release:

```sh
npm run rollback:control-center -- .control-center/releases/<release-id>.json
```

Rollback order is Pages, Worker, then VPS. D1 is not reversed because Worker versions do not version D1 data. Every migration must therefore remain backward compatible.

## 6. Recovery boundaries

- Initial deployments without previous Worker or Pages versions cannot roll those components back.
- A newly created Access app is removed automatically only when Pages was not deployed.
- D1 databases, migrations, metric samples, and incident history are retained.
- A partially failed VPS rollout automatically calls `rollback` on nodes that changed successfully.
- Release state files contain IDs and outcomes but never API tokens or service secrets.

Detailed procedures: `docs/disaster-recovery.md`, `docs/security-model.md`, and `docs/operations-observability.md`.
