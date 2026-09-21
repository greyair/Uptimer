# Fork Differences

This document tracks the functional and architectural differences between **greyair/Uptimer** and the upstream project **VrianCao/Uptimer**.

It is intended to be the first document checked before syncing upstream changes.

## Baseline

As of **2026-09-22**:

| Repository / branch | Commit | Notes |
| --- | --- | --- |
| Upstream `VrianCao/Uptimer:master` | `7bbe5191b31ae7b66fc088a7641861885f19bb0d` | Comparison baseline |
| Fork `greyair/Uptimer:master` | `9fe3ba39381b0c872c3a04340e38714bf06cbbd2` | Squash-merged extended feature set |
| Fork `feature/extended-monitoring` | `9519a901f1643ab4fad76888cfe0f6f3c1c8a6d3` | Current development/deployment branch, including post-merge monitor-edit fixes |

When this file is updated after an upstream sync, update the upstream commit above as well.

## Feature differences

| Area | Upstream | Greyair fork | Upstream contribution |
| --- | --- | --- | --- |
| Direct Cloudflare HTTP/TCP checks | Yes | Yes | Upstream |
| Globalping multi-region HTTP/HTTPS checks | No | Yes | Not submitted |
| Latest per-region Globalping status/latency | No | Yes | Not submitted |
| 24-hour per-region Globalping history | No | Yes | Not submitted |
| SSL certificate expiration | No | Yes | Not submitted |
| Domain registration expiration via RDAP | No | Yes | Not submitted |
| SSL/domain expiration notification events | No | Yes | Not submitted |
| WPush notification preset | No | Yes | Upstream PR #103 |
| Per-monitor notification channel scope | No | Yes | Upstream PR #102 |
| Simulated monitor notification tests | No | Yes | Not submitted |
| Remote MCP management endpoint | No | Yes | Not submitted |
| Pages deployment revision verification | No | Yes | Fork-only |
| Pages stale-shell cache protection | No | Yes | Fork-only |
| Structured Admin validation errors in lazy router | No | Yes | Fork-only compatibility fix |
| Direct monitor edit compatibility with empty Globalping locations | No | Yes | Fork-only compatibility fix |

## Globalping

### Probe mode

HTTP/HTTPS monitors can use either:

- `direct` — original Cloudflare Worker fetch path
- `globalping` — one Globalping measurement request with up to 10 configured location selectors

The aggregate monitor result uses the existing Uptimer state machine:

- if every region is UP, the aggregate result is UP
- if any region is DOWN, the aggregate result is DOWN
- otherwise the aggregate result may be UNKNOWN
- aggregate latency is the average of usable regional latency values

The existing `check_results` row remains the aggregate history used by the normal uptime/latency UI.

### Latest per-region state

The latest regional result is persisted in `monitor_extensions`:

- `globalping_last_results_json`
- `globalping_last_checked_at`

Public endpoint:

```text
GET /api/v1/public/globalping-status
```

The status card shows the latest region labels and latency values.

### Per-region history

Migration `0017_globalping_history.sql` adds:

```text
globalping_history
  monitor_id
  checked_at
  results_json
```

Each scheduled Globalping check stores one JSON snapshot containing all regions for that timestamp.

Public endpoint:

```text
GET /api/v1/public/monitors/:id/globalping-history?range=24h
```

The monitor detail UI keeps the original aggregate latency chart and adds one regional chart per Globalping location.

Regional history is collected only after migration `0017` is deployed; older regional history cannot be reconstructed from aggregate `check_results`.

### Current limitations

- Globalping mode supports HTTP/HTTPS monitors only.
- TCP monitors remain direct.
- Request bodies are not supported by the Globalping adapter.
- Globalping controls redirect semantics rather than Uptimer's direct `follow_redirects` implementation.
- A configured region failure affects the aggregate monitor result.
- Location selectors are capped at 10.

## SSL certificate expiration

SSL expiry checks are available for HTTPS monitors.

Important implementation detail: **Cloudflare Workers do not provide the peer-certificate inspection API used by the original prototype**, so the current implementation does **not** read certificates through `node:tls.getPeerCertificate()`.

Instead, `apps/worker/src/monitor/ssl.ts` creates a Globalping HTTPS measurement and reads TLS metadata from the Globalping result:

- authorization state
- expiration timestamp
- subject
- issuer
- TLS error

Behavior:

- HTTPS targets only
- refresh interval: at most once every 12 hours
- optional `GLOBALPING_API_TOKEN` is reused for SSL measurements
- SSL expiry does not directly mark the uptime monitor DOWN
- warning threshold is configurable from 1 to 365 days

## Domain expiration

Domain expiration checks use RDAP:

1. load the IANA DNS RDAP bootstrap
2. resolve the authoritative RDAP server for the TLD
3. query the explicitly configured registrable domain
4. read the `expiration` event

Behavior:

- refresh interval: at most once every 24 hours
- registrable domain must be configured explicitly, for example `example.com`
- no PSL extraction is attempted
- no WHOIS scraping fallback is used
- missing or unsupported expiration data is stored as an error rather than guessed

## Expiry notification events

The fork adds:

```text
monitor.ssl.expiring
monitor.domain.expiring
```

Deduplication reuses the existing `notification_deliveries` table.

The event key includes:

- monitor id
- expiry kind
- expiration timestamp
- warning threshold

A renewed certificate/domain expiry or changed warning threshold naturally produces a new notification cycle.

## Notification differences

### WPush preset

The fork adds WPush alongside Custom Webhook and Telegram.

WPush supports:

- encrypted API key stored in D1
- Worker Secret reference
- channel list
- optional channel instance `option`
- optional URL
- timeout
- title template
- message template
- event whitelist

Direct API keys are AES-GCM encrypted using a key derived from `ADMIN_TOKEN`. The Admin API never returns the encrypted key material.

### Per-monitor channel scope

Custom Webhook, Telegram, and WPush configurations can include:

```json
{
  "monitor_ids": [1, 3]
}
```

Rules:

- missing or empty scope means all monitors
- scoped channels receive matching monitor events only
- incident/maintenance events are filtered using their associated monitor ids
- `test.ping` always bypasses monitor scope so transport connectivity remains testable

This feature is submitted upstream as **VrianCao/Uptimer PR #102**.

### Simulated notification tests

The Admin test endpoint supports:

```text
test.ping
monitor.down
monitor.up
monitor.ssl.expiring
monitor.domain.expiring
```

For monitor events, a monitor id can be selected. This allows the UI to verify whether channel monitor scope sends or skips the event.

## MCP

The fork exposes a stateless remote MCP endpoint:

```text
POST /api/mcp
POST /api/v1/mcp
```

Authentication:

- preferred: Worker secret `MCP_TOKEN`
- fallback: `ADMIN_TOKEN`

GitHub Actions can map repository secret `UPTIMER_MCP_TOKEN` to Worker secret `MCP_TOKEN`.

See [MCP](mcp.md) for protocol compatibility and the current tool list.

## Database differences

The fork adds the following migrations after the upstream schema.

### 0015_monitor_extensions.sql

Adds `monitor_extensions` for optional monitor features:

- probe mode
- Globalping location selectors
- SSL enable/warn/last-check/expiry/error
- domain name/warn/last-check/expiry/error

The core `monitors` and `monitor_state` tables stay mostly unchanged to reduce upstream sync conflicts.

### 0016_globalping_latest_results.sql

Adds:

- `globalping_last_results_json`
- `globalping_last_checked_at`

It also clears existing SSL check timestamps/errors once so older deployments immediately retry SSL checks using the Globalping TLS metadata implementation.

### 0017_globalping_history.sql

Adds `globalping_history` with one all-region JSON snapshot per monitor/check timestamp and an index on `(monitor_id, checked_at DESC)`.

The existing retention task also removes expired Globalping history.

## Admin API differences

Monitor create/patch payloads add writable fields:

```json
{
  "probe_mode": "direct",
  "globalping_locations": [],
  "ssl_check_enabled": false,
  "ssl_warn_days": 30,
  "domain_name": null,
  "domain_warn_days": 30
}
```

Monitor responses also expose read-only latest expiry/check fields.

The immediate monitor test response can include per-region Globalping results.

Notification test requests can include a simulated event type and monitor id.

### Monitor-edit compatibility fix

The web form submits `globalping_locations: []` for Direct monitors. The PATCH schema therefore intentionally allows an empty array so unrelated edits such as renaming an existing Direct monitor remain valid.

Globalping mode still requires at least one location at the route-level compatibility check.

### Structured lazy-router errors

The production Admin router is lazily imported and invoked through `adminRoutes.fetch()`.

The fork registers `onError(handleError)` and `notFound(handleNotFound)` directly on that router so validation failures remain structured API responses such as:

```text
400 INVALID_ARGUMENT
```

instead of becoming a generic HTTP 500.

## Public API differences

Additional public endpoints:

```text
GET /api/v1/public/globalping-status
GET /api/v1/public/monitors/:id/globalping-history?range=24h
```

The existing public monitor/status APIs remain the source of aggregate status and uptime history.

## UI differences

### Admin

Monitor form adds:

- Direct / Globalping selector
- Globalping locations
- SSL expiry toggle and warning days
- domain name and warning days

Monitor list adds:

- Globalping badge
- SSL expiry / pending / error
- domain expiry / pending / error

Immediate Globalping tests show per-region:

- location
- status
- HTTP status
- latency
- error

Notification UI adds:

- WPush preset
- per-monitor channel scope
- simulated event selector
- test monitor selector
- explicit `skipped` result when monitor scope filters a test

### Public status page

Globalping cards add latest regional status/latency badges.

Monitor detail keeps the aggregate 24-hour latency chart and adds regional Globalping latency history charts.

## Deployment differences

The fork's GitHub Actions deployment additionally supports:

- optional `UPTIMER_MCP_TOKEN` -> Worker `MCP_TOKEN`
- generated `build-info.json` containing deployed commit and build time
- post-deploy production Pages revision verification
- post-deploy Globalping status endpoint verification

Pages caching rules:

- `/index.html`: no-cache/no-store
- `/build-info.json`: no-cache/no-store
- hashed `/assets/*`: immutable long cache

This avoids a stale SPA shell continuing to load an old frontend after Worker updates.

## Upstream contributions

As of 2026-09-22:

| PR | Feature | State |
| --- | --- | --- |
| [#102](https://github.com/VrianCao/Uptimer/pull/102) | Per-monitor notification channel scoping | Open |
| [#103](https://github.com/VrianCao/Uptimer/pull/103) | WPush notification preset | Open |

If either PR is merged upstream, remove that feature from the fork-only list after the next upstream sync and resolve any duplicate implementation before merging.

## Upstream sync risk map

### High-conflict files

Review these carefully on every upstream sync:

- `apps/worker/src/routes/admin.ts`
- `apps/worker/src/scheduler/scheduled.ts`
- `apps/worker/src/scheduler/notifications.ts`
- `apps/worker/src/notify/webhook.ts`
- `apps/worker/src/schemas/monitors.ts`
- `apps/worker/src/schemas/notification-channels.ts`
- `packages/db/src/json.ts`
- `packages/db/src/schema.ts`
- `apps/web/src/components/MonitorForm.tsx`
- `apps/web/src/components/NotificationChannelForm.tsx`
- `apps/web/src/pages/AdminDashboard.tsx`
- `apps/web/src/pages/StatusPage.tsx`
- `.github/workflows/deploy.yml`

### Mostly isolated fork modules

These should normally have lower merge conflict risk:

- `apps/worker/src/monitor/extensions.ts`
- `apps/worker/src/monitor/globalping.ts`
- `apps/worker/src/monitor/ssl.ts`
- `apps/worker/src/monitor/rdap.ts`
- `apps/worker/src/monitor/auxiliary.ts`
- `apps/worker/src/notify/wpush-token.ts`
- `apps/worker/src/mcp/handler.ts`
- `apps/worker/migrations/0015_monitor_extensions.sql`
- `apps/worker/migrations/0016_globalping_latest_results.sql`
- `apps/worker/migrations/0017_globalping_history.sql`

## Recommended upstream sync procedure

Do not use GitHub's one-click Sync Fork directly for non-trivial upstream changes.

Recommended flow:

1. fetch the latest upstream `master`
2. compare the new upstream commit range with the baseline recorded in this document
3. create a dedicated `sync-upstream-YYYYMMDD` branch from the fork's current `master`
4. merge/rebase upstream only on that branch
5. resolve textual conflicts
6. review semantic conflicts against every feature in this document
7. run lint, typecheck, cron tests, and full Worker tests
8. deploy a test/preview revision if the change touches runtime or migrations
9. verify Direct, Globalping, expiry, notification, and MCP behavior
10. update this document's baseline SHA
11. merge the sync branch into fork `master`

This document should be updated whenever a fork-only feature is added, removed, or accepted upstream.
