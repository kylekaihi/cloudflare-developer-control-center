# VPS status-api

Small read-only HTTP service for the Developer Control Center. It reports host CPU, memory, disk, uptime, and the health of explicitly configured local service endpoints. It has no restart, stop, trading, database-write, or Redis-write routes.

## Run on the VPS

```sh
cp .env.example .env
# Edit .env and use a long random STATUS_SERVICE_TOKEN.
set -a; . ./.env; set +a
node server.mjs
```

For a persistent systemd service, install this directory at `/opt/developer-control-center/status-api`, copy `developer-control-center-status.service` to `/etc/systemd/system/`, and create `/etc/developer-control-center/status-api.env` with mode `600`:

```sh
sudo install -d -m 750 /etc/developer-control-center
sudo install -m 600 /dev/stdin /etc/developer-control-center/status-api.env <<'EOF'
STATUS_API_PORT=18787
STATUS_SERVICE_TOKEN=replace-with-a-long-random-token
STATUS_GIT_COMMIT=manual
STATUS_SERVICES_JSON=[]
STATUS_PNL_SUMMARY_JSON=null
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now developer-control-center-status
curl http://127.0.0.1:18787/healthz
```

Bind it to the VPS private network only. The Cloudflare Worker reaches `/api/status` through Mesh and sends the token in `X-Status-API-Token`.

For repeatable operation across all configured nodes, configure `VPS_DEPLOY_TARGETS` and run the repository-level lifecycle command:

```sh
npm run vps:status-api -- install
npm run vps:status-api -- upgrade
npm run vps:status-api -- healthcheck
npm run vps:status-api -- rollback
```

The installer stores content-addressed releases under `/opt/developer-control-center/releases`, switches the `status-api` symlink atomically, and keeps `status-api.previous` for rollback. Each release contains its own mode-600 environment file, while `/etc/developer-control-center/status-api.env` follows the active release. Reinstalling identical code and configuration is idempotent. A failed upgrade restores the prior code and Token automatically. The service token is transferred in a mode-600 temporary environment file and is never placed on the SSH command line.

The service definitions are JSON so the API can monitor the existing Bot health endpoints without importing their code. Only private HTTP targets are accepted for local service health checks. Keep those URLs on loopback or the private Docker network; do not publish port 18787 to the Internet.

### Public HTTP/HTTPS checks

`STATUS_EXTERNAL_CHECKS_JSON` optionally configures public endpoints for external availability monitoring:

```json
[{"id":"public-api","name":"Public API","url":"https://example.com/health","expectedStatus":200,"timeoutMs":3000,"tlsWarningDays":30,"tlsCriticalDays":7}]
```

The agent records status code and latency. For HTTPS URLs it also reads the peer certificate and reports warning/critical expiry thresholds. Checks reject credentials, private destinations, non-standard ports, and automatic redirects; at most 32 checks are accepted. The deployment helper passes `VPS_STATUS_EXTERNAL_CHECKS_JSON` to the agents, and the Worker deduplicates identical check IDs across the Mesh nodes.

Docker auto-discovery is disabled by default because Docker socket access is root-equivalent. Prefer explicit health endpoints. The systemd service runs as a dynamic unprivileged user with a read-only filesystem sandbox; enable `STATUS_ENABLE_DOCKER_DISCOVERY=true` only if you have designed a separate least-privilege Docker telemetry boundary.
