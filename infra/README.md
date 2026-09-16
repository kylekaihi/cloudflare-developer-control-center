# Control Center infrastructure

The Mesh compose file is intentionally a fragment so it can be merged into the existing VPS Docker Compose stack without changing Bot, database, or Redis service definitions.

```sh
MESH_NODE_TOKEN="<token-from-cloudflare-mesh>" docker compose \
  -f /path/to/existing/compose.yaml \
  -f infra/cloudflare-mesh.compose.yaml up -d cloudflare-mesh

docker exec cloudflare-mesh warp-cli status
```

Create the Mesh node and token in Cloudflare One > Networking > Mesh. Keep the token outside Git. The `mesh_data` volume preserves the node identity across recreations. Add a route in Mesh if the status-api is on a private subnet behind the node; otherwise target the Mesh node IP or the host private IP reachable from the node.

After all VPS status APIs are reachable from the Mesh network, set the Worker `STATUS_SERVICE_HOSTS` JSON array to their Mesh/private IPs and deploy the status Worker.

## One-time Control Center deployment

No Cloudflare resources are changed while preparing the code. When authorization is available, copy the example configuration and fill it locally:

```sh
cp infra/control-center.env.example .env.control-center
set -a
. ./.env.control-center
set +a
npm run deploy:control-center
```

The API token needs these account permissions:

- Account Settings Read
- Access: Apps and Policies Write
- D1 Edit
- Workers Scripts Edit
- Pages Edit

The script is idempotent: it reuses the D1 database and Access application by name/domain, updates the Access allow policy, applies only pending migrations, preserves existing Worker secrets, then deploys the Worker and Pages project once.

Before making any Cloudflare change it runs the full local preflight and quality gates. It also upgrades the status API on all configured VPS nodes, records the current Worker and Pages production versions, performs post-deploy acceptance checks, and automatically rolls versioned components back when acceptance fails.

Required configuration:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ACCESS_TEAM_DOMAIN`, for example `your-team.cloudflareaccess.com`
- `ACCESS_ALLOWED_EMAILS`, comma-separated
- `STATUS_API_TOKEN` or a Cloudflare Access service-token pair for automated acceptance checks
- `VPS_DEPLOY_TARGETS` with one or more SSH and Mesh endpoints, unless `SKIP_VPS_DEPLOY=true`
- `STATUS_SERVICE_TOKEN` when VPS deployment is enabled

Telegram values are optional. When omitted, incident persistence works but outbound notifications remain disabled.

Local checks can be run without Cloudflare authorization:

```sh
npm run preflight
```

With `.env.control-center` loaded, the exact deployment gate is:

```sh
npm run preflight:deploy
```

Each deployment writes a secret-free state file under `.control-center/releases/`. To roll back the latest release, or a specific release, use:

```sh
npm run rollback:control-center
npm run rollback:control-center -- .control-center/releases/<release-id>.json
```

Worker and Pages return to the recorded production versions. VPS nodes swap back to their `previous` release. D1 migrations and monitoring data are deliberately retained.

For a full pre-change D1 export and Cloudflare configuration snapshot:

```sh
npm run backup:control-center
```

See `docs/disaster-recovery.md` for checksum verification and explicitly confirmed restore commands. See `docs/security-model.md` for staged service-token rotation.

The VPS lifecycle can also be operated independently:

```sh
npm run vps:status-api -- install
npm run vps:status-api -- upgrade
npm run vps:status-api -- healthcheck
npm run vps:status-api -- rollback
```
