# Cloudflare Developer Control Center

面向 Cloudflare 与 VPS 环境的开源开发者运维控制中心，提供双语 Dashboard、PWA、主机与服务监控、历史数据、事件告警及安全的白名单运维操作。

An open-source, mobile-friendly operations dashboard for small Cloudflare and VPS environments. It combines Cloudflare Pages, Workers, Access, D1, Cloudflare One Mesh, and lightweight Node.js agents into one deployable control center.

## Features

- Bilingual Chinese/English responsive dashboard and installable PWA
- Multi-VPS health, CPU, memory, disk, uptime, network, and service monitoring
- Historical metrics, service availability, incidents, and event timelines in D1
- Docker service discovery with stale-service cleanup and configurable alert thresholds
- Access-protected maintenance windows that suppress matching incident notifications
- Optional allowlisted service restart and redacted log viewing
- Cloudflare Access authentication and service-token verification
- Optional Telegram and Web Push notifications
- Automated backup, deployment, verification, rollback, and token rotation scripts
- Read-only-by-default VPS status agent with SSRF and timing-safe token protections

## Architecture

```text
Browser / PWA
    │ Cloudflare Access
    ▼
Cloudflare Pages + Pages Function
    │ Service Binding
    ▼
Status Worker ───── D1 history / incidents
    │ Cloudflare One Mesh
    ├── VPS status agent :18787
    ├── VPS status agent :18787
    └── VPS status agent :18787
```

See [docs/DEVELOPER-CONTROL-CENTER.md](docs/DEVELOPER-CONTROL-CENTER.md) for the detailed design and [docs/security-model.md](docs/security-model.md) for the security boundaries.

## Requirements

- Node.js 22.12 or newer
- A Cloudflare account with Workers, Pages, D1, Access, and Cloudflare One Mesh
- Three Linux VPS nodes reachable through the Mesh (the scripts can be adapted for a different count)
- SSH access to each VPS for agent deployment

## Quick start

```sh
npm ci
npm run configure:control-center
```

Edit the generated `.env.control-center`. It is mode `0600` and ignored by Git. The required values and Cloudflare API permissions are documented in [infra/control-center.env.example](infra/control-center.env.example).

Run the local quality gate:

```sh
set -a
. ./.env.control-center
set +a
npm run preflight:deploy
```

Deploy the complete stack:

```sh
set -a
. ./.env.control-center
set +a
npm run deploy:control-center
```

The deployment workflow performs a D1 backup, installs or upgrades all VPS agents, provisions Access, applies migrations, deploys the Worker and Pages application, and runs post-deployment acceptance checks. Automatic rollback is enabled by default.

## Development

```sh
npm run dev
npm test
npm run test:worker
npm run build
```

Useful commands:

```sh
npm run backup:control-center
npm run verify:control-center
npm run rollback:control-center
npm run rotate:service-token
```

## Security

Never commit `.env.control-center`, Cloudflare tokens, Access service-token credentials, SSH keys, Wrangler state, or backup exports. Public examples use placeholders only.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
