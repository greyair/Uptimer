# Extended Monitoring

This fork adds a low-intrusion extension layer on top of Uptimer. The existing monitor/state tables stay mostly unchanged; optional features are stored in `monitor_extensions` so future upstream syncs remain manageable.

## Added features

- **Globalping multi-region HTTP/HTTPS checks**
  - Keep the original Cloudflare direct probe.
  - Per monitor, choose `direct` or `globalping`.
  - Configure up to 10 Globalping location selectors.
  - One probe is requested per configured location.
  - The aggregate check fails if any configured probe fails.
  - Individual region results are returned by the Admin "Test monitor" endpoint.
- **TLS/SSL certificate expiration**
  - HTTPS monitors can inspect the peer certificate.
  - Checked at most once every 12 hours.
  - Stores expiration timestamp and the last error.
- **Domain registration expiration**
  - Uses the IANA RDAP bootstrap and the authoritative RDAP server for the TLD.
  - Checked at most once every 24 hours.
  - Configure the registrable domain explicitly, for example `example.com`.
- **Expiry notifications**
  - New events: `monitor.ssl.expiring` and `monitor.domain.expiring`.
  - Notification idempotency reuses `notification_deliveries`.
  - The event key includes monitor, kind, expiration timestamp, and warning threshold, so the same expiration cycle is not sent repeatedly.
- **WPush notification preset**
  - Uses `POST https://api.wpush.cn/api/v1/send`.
  - Supports WPush channel lists such as `wechat,app,mail`.
  - Supports optional channel instance `option`, message URL, title template, and message template.
  - API keys can be AES-GCM encrypted in D1 or referenced through a Worker Secret.

## Database migration

Apply migration `0015_monitor_extensions.sql` before deploying the new Worker:

```bash
pnpm --filter @uptimer/worker migrate:local
```

For remote deployments, the existing GitHub Actions deployment flow applies D1 migrations automatically.

The extension table stores:

- probe mode and Globalping location selectors
- SSL enabled flag, warning threshold, last check, expiration, error
- domain name, warning threshold, last check, expiration, error

## Globalping token

Globalping works without authentication, subject to anonymous API limits.

For higher limits, define the optional Worker secret:

```bash
wrangler secret put GLOBALPING_API_TOKEN
```

The token is used both by scheduled checks and Admin test checks.

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

## Expiry check behavior

### SSL

- Only valid for HTTPS monitor targets.
- Runs independently from the normal uptime interval.
- Maximum refresh frequency: once per 12 hours.
- The configured warning threshold is 1–365 days.

### Domain

- Configure the registrable domain explicitly.
- Maximum refresh frequency: once per 24 hours.
- RDAP support depends on the TLD registry.
- If the RDAP response has no `expiration` event, the result is stored as an error instead of guessing from WHOIS text.

## Current Globalping limitations

The first implementation intentionally keeps scope small:

- Globalping mode currently supports **HTTP/HTTPS monitors only**.
- TCP monitors continue to use the original direct probe.
- Request bodies are currently rejected by the Globalping adapter.
- Redirect behavior is controlled by Globalping rather than Uptimer's direct-fetch `follow_redirects` implementation.
- One failed configured location makes the aggregate result fail.

These constraints keep the core Uptimer state machine and upstream code changes small.

## API fields

Admin monitor payloads now include:

```json
{
  "probe_mode": "direct",
  "globalping_locations": [],
  "ssl_check_enabled": false,
  "ssl_warn_days": 30,
  "ssl_last_checked_at": null,
  "ssl_expires_at": null,
  "ssl_error": null,
  "domain_name": null,
  "domain_warn_days": 30,
  "domain_last_checked_at": null,
  "domain_expires_at": null,
  "domain_error": null
}
```

The existing Admin CRUD endpoints accept the corresponding writable fields.

## Upstream sync strategy

Most additions are isolated in:

- `apps/worker/src/monitor/extensions.ts`
- `apps/worker/src/monitor/globalping.ts`
- `apps/worker/src/monitor/ssl.ts`
- `apps/worker/src/monitor/rdap.ts`
- `apps/worker/src/monitor/auxiliary.ts`
- `apps/worker/src/notify/wpush-token.ts`
- migration `0015_monitor_extensions.sql`

This is deliberate: when syncing the original Uptimer repository, the main expected conflict points are the Admin API, scheduler dispatch, notification union, and Admin forms rather than the core monitor/state schema.
