# Developer Control Center Status Worker

This Worker is the monitoring backend for the Control Center. It validates a Cloudflare Access JWT (with a bearer-token fallback for diagnostics), reaches the configured VPS status APIs through the Mesh VPC binding, stores time-series samples and incident state in D1, and keeps management writes limited to explicitly protected operations.

## Configure

The production deployment is orchestrated by `scripts/deploy-control-center.mjs`. It creates or reuses the D1 database, applies migrations, provisions the Access application and allow policy, configures the Pages service binding, and deploys the Worker and Pages site.

The existing upstream secret remains required:

```sh
cd worker/status-api
npx wrangler secret put STATUS_API_TOKEN
npx wrangler secret put STATUS_SERVICE_TOKEN
```

`STATUS_API_TOKEN` remains as a diagnostic fallback. The Dashboard does not receive or store it.

Optional Telegram secrets:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/status-api/wrangler.jsonc
npx wrangler secret put TELEGRAM_CHAT_ID --config worker/status-api/wrangler.jsonc
```

Notifications are queued only when both values are configured. An incident must remain present for `ALERT_CONFIRM_MINUTES` before opening. Telegram receives one open message and one recovery message.

## API contract

- `GET /api/status` — current aggregate, nodes, services, persistent open incidents, and one-hour history.
- `GET /api/metrics?range=1h|24h|7d&host=<optional>` — bucketed D1 metrics.
- `GET /api/incidents?status=pending|open|resolved|all&limit=100` — incident timeline.
- `GET /api/maintenance` — active maintenance windows; bearer-token reads are allowed.
- `POST /api/maintenance` — create a node- or service-scoped maintenance window; requires a Cloudflare Access identity.
- `DELETE /api/maintenance?id=<id>` — remove a maintenance window; requires a Cloudflare Access identity.
- `GET /healthz` — unauthenticated process health only.

The five-minute Cron Trigger performs collection. Metrics are retained for 90 days; resolved incidents and delivered notifications are retained for 180 days.

### Maintenance windows

Maintenance windows are persisted in D1 and can target one node, one service on a node, or all nodes/services. While a window is active, the Worker keeps collecting metrics and service state but suppresses new incident transitions and recovery/open notifications for matching conditions. When the window expires, normal confirmation and notification behavior resumes.

### Service discovery and alert rules

The VPS agent can discover Docker services without a manually maintained list. Set `STATUS_ENABLE_DOCKER_DISCOVERY=true` and use `STATUS_DOCKER_DISCOVERY_MODE=running` to list only currently running containers. Set `VPS_STATUS_DISCOVERY_MODE=replace` in the deployment environment to remove explicit health-check entries from the live list and use only discovered containers. This means stopped or removed containers no longer appear as current services.

Thresholds are configured with `VPS_STATUS_ALERT_RULES_JSON`, for example:

```json
{"cpu":{"warning":80,"critical":95},"memory":{"warning":85,"critical":95},"disk":{"warning":80,"critical":90},"serviceDown":{"enabled":true}}
```

The deployment script validates the mode and the agent bounds all threshold values to 0–100.

## Verify and deploy

```sh
npx wrangler deploy --dry-run
npx wrangler deploy
curl https://developer-control-center-status.<your-subdomain>.workers.dev/healthz
curl -H "Authorization: Bearer $STATUS_API_TOKEN" \
  https://developer-control-center-status.<your-subdomain>.workers.dev/api/status
```

The browser uses `/dashboard/api/*`. A Pages Function forwards authenticated requests to this Worker over a service binding, so no API token is present in HTML, JavaScript, local storage, or session storage.
