# Developer Control Center security model

## Protected assets and trust boundaries

The protected assets are Cloudflare credentials, the two status tokens, Access identity assertions, VPS runtime data, incident history, and release metadata. The system has four trust boundaries:

1. Browser → Cloudflare Access → Pages Function.
2. Pages Function → Status Worker service binding.
3. Status Worker → Workers VPC → Mesh → VPS status API.
4. Operator workstation → Cloudflare API and configured VPS SSH endpoints.

The monitoring surface remains read-only. The separately authorized control route can read bounded Docker logs or restart an explicitly allowlisted non-trading container. It cannot stop services, reboot hosts, execute arbitrary commands, alter trading state, write arbitrary D1 rows, or access Redis/databases on a VPS.

## Implemented controls

- Cloudflare Access protects `/dashboard/*`; the Pages Function forwards only `status`, `metrics`, and `incidents` GET requests.
- Pages static responses and Function responses set clickjacking, MIME-sniffing, referrer, permissions, HSTS, and CSP protections. Dashboard responses are marked `noindex`.
- Worker responses are `no-store`, and the PWA never stores `/dashboard/api/*` responses.
- The Worker uses an Access assertion or a constant-time bearer-token fallback. The upstream service token is never sent to the browser.
- VPS probes accept only private HTTP endpoints. Public IPs, link-local metadata addresses, HTTPS/public hostnames, credentials in URLs, and non-HTTP schemes are rejected.
- Docker discovery is disabled by default because Docker socket membership is root-equivalent. Prefer explicit local health endpoints.
- The VPS process runs under a systemd dynamic user with no capabilities, a read-only filesystem view, private devices/tmp, and kernel/control-group restrictions.
- The control agent uses a distinct token, an exact service/container allowlist, fixed Docker CLI arguments, typed restart confirmation, bounded/redacted logs, and D1 audit records. Freqtrade, Polymarket, and trading Bot containers are excluded.
- Release, backup, and rotation state is mode `0600` under the Git-ignored `.control-center/` directory. State files store fingerprints and resource IDs, never secret values.

## Token separation and rotation

`STATUS_API_TOKEN` authorizes an operator diagnostic read against the public Worker. `STATUS_SERVICE_TOKEN` authenticates Worker-to-VPS traffic. They must be distinct.

Service-token rotation is staged to avoid an outage:

```sh
export OLD_STATUS_SERVICE_TOKEN='...'
export NEW_STATUS_SERVICE_TOKEN='...'
npm run rotate:service-token -- prepare --confirm=ROTATE_SERVICE_TOKEN

# Observe for at least one collection interval, then remove the previous token.
npm run rotate:service-token -- finalize --confirm=ROTATE_SERVICE_TOKEN
```

During `prepare`, VPS nodes accept the new and previous token while the Worker switches to the new value. `finalize` removes the previous value. Before finalization, this restores the old token:

```sh
npm run rotate:service-token -- abort --confirm=ROTATE_SERVICE_TOKEN
```

Never place tokens in command arguments, shell history, GitHub Actions files, logs, screenshots, or issue trackers.

## Residual risks

- Cloudflare account compromise can bypass application controls; enforce phishing-resistant MFA and least-privilege API tokens.
- The operator workstation is a privileged deployment boundary; protect SSH keys and local environment files.
- D1 Time Travel/exports protect monitoring data, not external Bot databases.
- A first deployment has no prior Worker or Pages version to restore.
- `script-src 'unsafe-inline'` remains necessary for the current static Dashboard script. Moving the Dashboard script to a generated external module would allow a stricter CSP in a later batch.
