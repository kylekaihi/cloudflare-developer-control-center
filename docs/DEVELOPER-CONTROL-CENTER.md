# Developer Control Center 部署手册

本仓库现在包含文档中的 MVP：现有 Astro Pages 站点新增 `/dashboard/`，独立的 Status Worker 通过 Workers VPC 访问 Mesh 后的 VPS `status-api`，VPS 只提供只读监控数据。

交易 Bot、数据库、Redis、WebSocket、风控和 Kill Switch 不迁移到 Worker，也没有在 Dashboard 暴露任何写操作。

## 1. 先准备 Cloudflare Mesh

在 Cloudflare One 控制台进入 `Networking > Mesh`：

1. 创建一个 Mesh node，例如 `vps-control-center`，复制节点 token。
2. 在 VPS 上把 `infra/cloudflare-mesh.compose.yaml` 合并到现有 Compose stack。
3. 持久化 `mesh_data`，并确认宿主机有 `/dev/net/tun`。
4. 启动后执行 `docker exec cloudflare-mesh warp-cli status`，确认状态为 Connected。
5. 记录 VPS Mesh IP，或为承载 status-api 的私网网段添加 Mesh route。

Cloudflare Mesh 当前通过 `warp-cli` 运行 Linux 节点，容器部署需要 `cloudflare/mesh`、`NET_ADMIN`、`NET_RAW`、`/dev/net/tun` 和持久化 `/var/lib/cloudflare-warp`。

## 2. 部署 VPS status-api

在 VPS 上复制 `status-api/`，然后配置：

```sh
cp status-api/.env.example status-api/.env
# 修改 STATUS_SERVICE_TOKEN、STATUS_SERVICES_JSON
set -a; . ./status-api/.env; set +a
node status-api/server.mjs
```

`STATUS_SERVICES_JSON` 只填写本机或 Docker 私网里的健康检查 URL，例如：

```json
[
  {"name":"Polymarket Bot","url":"http://127.0.0.1:8000/health"},
  {"name":"Bitbank Bot","url":"http://127.0.0.1:8001/health"}
]
```

不要把 18787 端口发布到公网；让它只通过 Mesh 或私网可达。

## 3. 配置和部署 Status Worker

编辑 `worker/status-api/wrangler.jsonc`：

- `STATUS_SERVICE_HOSTS` 改成所有 status-api 的 Mesh/private IP JSON 数组。
- `ALLOWED_ORIGINS` 改成真实 Dashboard 来源，例如 `https://dashboard.example.com`。

然后在已登录目标 Cloudflare 账号的终端执行：

```sh
cd worker/status-api
npx wrangler secret put STATUS_API_TOKEN
npx wrangler secret put STATUS_SERVICE_TOKEN
npx wrangler deploy --dry-run
npx wrangler deploy
```

`STATUS_API_TOKEN` 给 Dashboard 使用；`STATUS_SERVICE_TOKEN` 只由 Worker 发给 VPS status-api。不要把任何 token 写进 `wrangler.jsonc`、`.env` 或 Git。

验证：

```sh
curl https://developer-control-center-status.<subdomain>.workers.dev/healthz
curl -H "Authorization: Bearer <STATUS_API_TOKEN>" \
  https://developer-control-center-status.<subdomain>.workers.dev/api/status
```

## 4. 发布 Pages Dashboard

当前 Dashboard 和现有博客共用 Astro Pages 项目，构建后访问 `/dashboard/`。在 Pages 项目设置中加入构建变量：

```text
PUBLIC_STATUS_API_URL=https://developer-control-center-status.<subdomain>.workers.dev/api/status
```

构建配置保持：

```text
Build command: npm run build
Build directory: dist
```

如果使用 Direct Upload：

```sh
npm run verify
npm run build
npx wrangler pages deploy dist --project-name <pages-project>
```

如果使用现有 Git 集成，则将变更合并到生产分支，由 Pages 自动构建。

## 5. 安全上线前检查

- 给 Dashboard 域名和 Status Worker 配置 Cloudflare Access / MFA。
- 先只允许自己的邮箱或管理组访问。
- 先确认 `/api/status` 只返回健康状态和资源摘要。
- 不要加入 restart、stop、下单、Kill Switch、数据库写入或 Redis 操作。
- 确认 Cloudflare 故障时，Bot、风控、交易所 WebSocket 和本地状态仍可独立运行。

Workers VPC 目前仍处于 beta；`cf1:network` VPC Network binding 通过 IP 访问 Mesh 节点或其路由后的私有服务，因此这里保留了明确的超时、一次重试和只读边界。
