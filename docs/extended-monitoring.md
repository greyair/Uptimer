# Extended Monitoring

This fork adds a low-intrusion extension layer on top of Uptimer. Optional features are kept mostly outside the core `monitors` and `monitor_state` tables so upstream synchronization remains manageable.

For the complete fork-vs-upstream inventory and sync risk map, see [Fork Differences](fork-differences.md).

## Added features

- **Globalping multi-region HTTP/HTTPS checks**
  - Keep the original Cloudflare direct probe.
  - Per monitor, choose `direct` or `globalping`.
  - Configure up to 10 Globalping location selectors.
  - One Globalping measurement is created with one probe per configured location.
  - The aggregate monitor result reuses the existing Uptimer state machine.
  - Individual region results are returned by the Admin "Test monitor" endpoint.
  - Latest regional state/latency is shown on the public status card.
  - 24-hour regional latency history is available in monitor details.
- **TLS/SSL certificate expiration**
  - HTTPS monitors can track certificate authorization and expiration.
  - Certificate metadata is obtained from a Globalping HTTPS measurement.
  - Checked at most once every 12 hours.
  - Stores expiration timestamp and the last error.
- **Domain registration expiration**
  - Uses the IANA RDAP bootstrap and the authoritative RDAP server for the TLD.
  - Checked at most once every 24 hours.
  - Configure the registrable domain explicitly, for example `example.com`.
- **Expiry notifications**
  - New events: `monitor.ssl.expiring` and `monitor.domain.expiring`.
  - Notification idempotency reuses `notification_deliveries`.
  - The event key includes monitor, kind, expiration timestamp, and warning threshold.
- **WPush notification preset**
  - Uses `POST https://api.wpush.cn/api/v1/send`.
  - Supports WPush channel lists such as `wechat,app,mail`.
  - Supports optional channel instance `option`, message URL, title template, and message template.
  - API keys can be AES-GCM encrypted in D1 or referenced through a Worker Secret.
- **Per-monitor notification scope**
  - Notification channels can optionally target selected monitor ids.
  - Empty scope preserves the original "all monitors" behavior.
- **Simulated notification tests**
  - Admin tests can simulate monitor up/down and SSL/domain expiry events against a selected monitor.

## Database migrations

Remote deployments apply migrations automatically through GitHub Actions.

### 0015_monitor_extensions.sql

Adds the `monitor_extensions` table for:

- probe mode
- Globalping location selectors
- SSL enabled flag, warning threshold, last check, expiration, error
- domain name, warning threshold, last check, expiration, error

### 0016_globalping_latest_results.sql

Adds:

- `globalping_last_results_json`
- `globalping_last_checked_at`

It also clears existing SSL check timestamps/errors once so upgraded deployments immediately retry SSL checks using the current Globalping TLS metadata implementation.

### 0017_globalping_history.sql

Adds `globalping_history`.

Each scheduled Globalping check stores one JSON snapshot containing all configured regions for that timestamp. The existing retention job removes expired history.

For local development:

```bash
pnpm --filter @uptimer/worker migrate:local
```

## Globalping token

Globalping works without authentication, subject to anonymous API limits.

For higher limits, define the optional Worker secret:

```bash
wrangler secret put GLOBALPING_API_TOKEN
```

The token is used by:

- scheduled Globalping monitor checks
- Admin test checks
- SSL certificate metadata checks

## Globalping result storage

The normal `check_results` table continues to store one aggregate result per scheduled check.

Regional data is stored separately:

- latest regional state: `monitor_extensions.globalping_last_results_json`
- latest regional timestamp: `monitor_extensions.globalping_last_checked_at`
- historical regional snapshots: `globalping_history`

This keeps the original uptime/statistics path unchanged while preserving per-region visibility.

## SSL implementation

Cloudflare Workers do not currently expose the peer-certificate inspection behavior required by the original `node:tls.getPeerCertificate()` prototype.

The production implementation therefore uses a Globalping HTTPS measurement and reads TLS metadata from its result:

- `authorized`
- `expiresAt`
- subject
- issuer
- TLS error

SSL expiry checks:

- are valid only for HTTPS monitor targets
- run independently from normal uptime checks
- refresh at most once every 12 hours
- do not directly mark the uptime monitor DOWN
- use a configurable warning threshold from 1 to 365 days

## Domain expiry behavior

- Configure the registrable domain explicitly.
- Refresh frequency is at most once per 24 hours.
- RDAP support depends on the TLD registry.
- If the RDAP response has no `expiration` event, the result is stored as an error.
- The implementation does not guess from scraped WHOIS text.
- The implementation does not attempt public-suffix extraction from the monitor URL.

## WPush

### Encrypted storage

In Admin → Notifications → WPush, paste the API key directly. Uptimer encrypts it before saving the channel config.

The encryption key is derived from `ADMIN_TOKEN`. Changing `ADMIN_TOKEN` means existing encrypted Telegram/WPush credentials must be re-entered.

### Worker Secret mode

Alternatively:

```bash
wrangler secret put UPTIMER_WPUSH_API_KEY
```

Then choose **Worker Secret ref** in the WPush advanced settings and use:

```text
UPTIMER_WPUSH_API_KEY
```

### Channels

The `channel` field is passed to WPush unchanged. Examples:

```text
wechat
wechat,app
wechat,mail,app
```

An optional `option` can select a configured WPush channel instance.

## Notification monitor scope

Notification channel configs can include:

```json
{
  "monitor_ids": [1, 3]
}
```

Rules:

- missing or empty `monitor_ids` means all monitors
- monitor events are delivered only when the monitor id is in scope
- incident/maintenance events use their associated monitor ids
- `test.ping` always bypasses monitor scope

## Simulated notification tests

The Admin test endpoint supports:

```text
test.ping
monitor.down
monitor.up
monitor.ssl.expiring
monitor.domain.expiring
```

For monitor-specific events, choose a monitor id. The result reports whether the channel sent the notification or skipped it because of monitor scope.

## Current Globalping limitations

- Globalping mode supports **HTTP/HTTPS monitors only**.
- TCP monitors continue to use the original direct probe.
- Request bodies are currently rejected by the Globalping adapter.
- Redirect behavior is controlled by Globalping rather than Uptimer's direct-fetch `follow_redirects` implementation.
- One failed configured location makes the aggregate result fail.
- Regional history begins only after migration `0017` is deployed.

## API fields

Admin monitor payloads add writable fields:

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

Responses also include latest SSL/domain result fields such as:

```json
{
  "ssl_last_checked_at": null,
  "ssl_expires_at": null,
  "ssl_error": null,
  "domain_last_checked_at": null,
  "domain_expires_at": null,
  "domain_error": null
}
```

Additional public endpoints:

```text
GET /api/v1/public/globalping-status
GET /api/v1/public/monitors/:id/globalping-history?range=24h
```

## Monitor edit compatibility

Direct monitor forms may submit:

```json
{
  "probe_mode": "direct",
  "globalping_locations": []
}
```

The PATCH schema intentionally accepts an empty Globalping location array so unrelated edits such as renaming a Direct monitor remain valid.

When `probe_mode` is actually `globalping`, the Admin route still requires at least one configured location.

## Upstream sync strategy

Mostly isolated fork modules:

- `apps/worker/src/monitor/extensions.ts`
- `apps/worker/src/monitor/globalping.ts`
- `apps/worker/src/monitor/ssl.ts`
- `apps/worker/src/monitor/rdap.ts`
- `apps/worker/src/monitor/auxiliary.ts`
- `apps/worker/src/notify/wpush-token.ts`
- `apps/worker/src/mcp/handler.ts`
- migrations `0015`–`0017`

Expected conflict points:

- Admin API
- scheduler persistence/notification dispatch
- notification config unions
- monitor and notification forms
- public status/detail UI
- deployment workflow

Before every upstream sync, use [Fork Differences](fork-differences.md) as the compatibility checklist.
