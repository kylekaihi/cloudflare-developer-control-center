# Control Center observability

## Questions the signals must answer

1. Did a browser request fail in Pages, in the Worker, or at a Mesh/VPS hop?
2. Are all configured nodes reachable during each five-minute collection?
3. Did an incident transition, and was its notification delivered?
4. Which release and request ID were involved without exposing a credential?

## Correlation and events

Pages accepts `CF-Ray` or a valid `X-Request-ID`, propagates it to the Worker, and returns `X-Request-ID`. The Worker propagates the same value to every VPS request. Invalid or oversized IDs are replaced with a UUID.

Every runtime event is one-line JSON with `timestamp`, `level`, `event`, `service`, and `requestId` where applicable. Stable events are:

- `pages_api_request`: Pages Function status and duration.
- `http_request`: Worker or VPS HTTP status and duration.
- `status_upstream_error`: no Mesh upstream was reachable.
- `scheduled_collection`: node reachability, conditions, transitions, and delivered notifications.
- `scheduled_collection_failed`: collection or D1 processing failed.
- `service_started`: VPS process startup configuration summary without secrets.

The Worker emits bounded fields. Tokens, assertions, cookies, request bodies, emails, full URLs, and arbitrary error messages must never be logged. Cloudflare Worker observability is enabled in `wrangler.jsonc`; `Server-Timing` exposes aggregate Pages/Worker duration to an authenticated browser without exposing internal errors.

## Operational thresholds

Use the existing incident confirmation window to suppress transient node failures. Initial suggested alerts must be tuned after collecting normal traffic:

- Page: all configured Mesh nodes unreachable for 3 consecutive collections.
- Page: a trading health endpoint remains down for 3 consecutive minutes.
- Ticket: any single node is unreachable for 10 minutes.
- Ticket: scheduled collection has no successful sample for 5 minutes.
- Ticket: notification outbox reaches 5 failed attempts.

Alerts must link to `docs/disaster-recovery.md`. Resource thresholds such as CPU and disk remain diagnostic signals; user-visible node/service availability is the paging symptom.

## Investigation sequence

1. Copy `X-Request-ID` from the failed Dashboard API response.
2. Search Pages Function and Worker logs for that request ID.
3. If the Worker reports `status_upstream_error`, inspect the corresponding `scheduled_collection` and failed host list.
4. Check Mesh and local status API on only the affected VPS.
5. Compare deployed releases in the Dashboard and `.control-center/releases/` before rollback.

Telemetry verification requires a staging or maintenance window: induce one denied request, one unreachable test endpoint, and one recovery; confirm structured events, incident transitions, and notification delivery without using real secrets in logs.
