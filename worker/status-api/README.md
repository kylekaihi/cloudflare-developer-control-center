# Developer Control Center Status Worker

This Worker is the read-only monitoring backend for the Control Center. It validates a Cloudflare Access JWT (with a bearer-token fallback for diagnostics), reaches the configured VPS status APIs through the Mesh VPC binding, stores time-series samples and incident state in D1, and never exposes a write operation to the browser.

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
- `GET /healthz` — unauthenticated process health only.

The five-minute Cron Trigger performs collection. Metrics are retained for 90 days; resolved incidents and delivered notifications are retained for 180 days.

## Verify and deploy

```sh
npx wrangler deploy --dry-run
npx wrangler deploy
curl https://developer-control-center-status.<your-subdomain>.workers.dev/healthz
curl -H "Authorization: Bearer $STATUS_API_TOKEN" \
  https://developer-control-center-status.<your-subdomain>.workers.dev/api/status
```

The browser uses `/dashboard/api/*`. A Pages Function forwards authenticated requests to this Worker over a service binding, so no API token is present in HTML, JavaScript, local storage, or session storage.
