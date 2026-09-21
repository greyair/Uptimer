# Notification System

English | [中文](notifications.zh-CN.md)

Uptimer sends notifications when monitor states change, incidents/maintenance events occur, or expiry warnings are raised.

This fork supports three notification channel modes:

- **Custom Webhook**
- **Telegram preset**
- **WPush preset**

For a full fork-vs-upstream inventory, see [Fork Differences](fork-differences.md).

## Event types

| Event | Description |
| --- | --- |
| `monitor.down` | Monitor transitioned to DOWN |
| `monitor.up` | Monitor transitioned to UP |
| `monitor.ssl.expiring` | SSL certificate is inside the configured warning window |
| `monitor.domain.expiring` | Domain registration is inside the configured warning window |
| `incident.created` | Incident created |
| `incident.updated` | Incident updated |
| `incident.resolved` | Incident resolved |
| `maintenance.started` | Maintenance window started |
| `maintenance.ended` | Maintenance window ended |
| `test.ping` | Transport/configuration test |

## Delivery flow

1. The system creates an event with `eventType`, `eventKey`, and payload.
2. Active notification channels are loaded.
3. Each channel is filtered by:
   - `enabled_events`
   - optional `monitor_ids`
4. A delivery slot is claimed in `notification_deliveries`.
5. The channel payload/message is rendered.
6. The request is sent.
7. Delivery result is stored as success/failed.

`test.ping` always bypasses event and monitor scope filtering so transport connectivity can be tested independently.

## Idempotency

`notification_deliveries` prevents the same event from being delivered repeatedly to the same channel.

Examples:

```text
monitor:<monitorId>:down:<timestamp>
monitor:<monitorId>:up:<timestamp>
monitor:<monitorId>:ssl-expiring:<expiresAt>:<warnDays>
monitor:<monitorId>:domain-expiring:<expiresAt>:<warnDays>
```

A renewed certificate/domain or changed warning threshold naturally creates a new expiry event key.

## Admin API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/v1/admin/notification-channels` | List channels |
| POST | `/api/v1/admin/notification-channels` | Create channel |
| PATCH | `/api/v1/admin/notification-channels/:id` | Update channel |
| DELETE | `/api/v1/admin/notification-channels/:id` | Delete channel |
| POST | `/api/v1/admin/notification-channels/:id/test` | Test channel |

The test endpoint supports:

```text
test.ping
monitor.down
monitor.up
monitor.ssl.expiring
monitor.domain.expiring
```

For monitor-specific test events, provide/select a monitor id. The response reports whether the delivery was sent or skipped by monitor scope.

## Common channel fields

All notification modes support the following concepts where applicable:

| Field | Description |
| --- | --- |
| `timeout_ms` | Request timeout |
| `message_template` | Rendered message template |
| `enabled_events` | Event whitelist; empty/omitted means all |
| `monitor_ids` | Optional monitor scope; empty/omitted means all monitors |

### Monitor scope

Example:

```json
{
  "monitor_ids": [1, 3]
}
```

Rules:

- missing or empty `monitor_ids`: all monitors
- monitor events: event monitor id must be in scope
- incident/maintenance events: at least one associated monitor must match
- `test.ping`: always allowed

## Custom Webhook

Custom Webhook supports:

- URL
- method: GET / POST / PUT / PATCH / DELETE / HEAD
- custom headers
- timeout
- payload type:
  - `json`
  - `param`
  - `x-www-form-urlencoded`
- message template
- payload template
- event whitelist
- monitor scope
- optional HMAC-SHA256 signing

### Default JSON payload

Without a custom payload template, a normal event payload is sent directly, for example:

```json
{
  "event": "monitor.down",
  "event_id": "monitor:1:down:1700000000",
  "timestamp": 1700000000,
  "monitor": {
    "id": 1,
    "name": "API"
  },
  "state": {
    "status": "down",
    "http_status": 500
  }
}
```

### Template syntax

Supported examples:

```text
{{event}}
{{monitor.name}}
{{state.status}}
{{checks[0].latency_ms}}
$MSG
```

Missing paths resolve to an empty string.

Template access rejects `__proto__`, `prototype`, and `constructor`.

Template substitution produces strings. If numeric types must be preserved, use the default payload instead of string interpolation.

### HMAC signing

When signing is enabled, Uptimer sends:

```text
X-Uptimer-Timestamp: <unix_seconds>
X-Uptimer-Signature: sha256=<hmac_hex>
```

Signature input:

```text
<timestamp>.<rawBody>
```

The signing secret is read from the Worker secret configured by `secret_ref`.

## Telegram preset

Telegram is a built-in preset.

It supports:

- bot token entered directly and encrypted before storage
- Worker Secret reference
- chat id
- optional message thread id
- parse mode
- silent/protected message options
- timeout
- message template
- event whitelist
- monitor scope

When the token is entered directly, it is encrypted before being saved. The Admin API never returns encrypted token material.

## WPush preset

WPush is a fork extension and is submitted upstream as PR #103.

It sends:

```text
POST https://api.wpush.cn/api/v1/send
Content-Type: application/x-www-form-urlencoded
```

Supported fields:

- API key entered directly and encrypted before storage
- Worker Secret reference
- `channel`
- optional `option`
- optional URL
- timeout
- title template
- message template
- event whitelist
- monitor scope

Example:

```json
{
  "preset": "wpush",
  "api_key_secret_ref": "UPTIMER_WPUSH_API_KEY",
  "channel": "wechat",
  "option": "ops"
}
```

When an API key is entered directly, it is AES-GCM encrypted using a key derived from `ADMIN_TOKEN`.

Changing `ADMIN_TOKEN` requires re-entering credentials that were encrypted with the previous token.

## Testing monitor scope

The Admin UI can test a real monitor scope instead of only transport connectivity.

Example:

```json
{
  "event_type": "monitor.down",
  "monitor_id": 3
}
```

If monitor #3 is outside the selected channel scope, the result is returned as **skipped** and no external request is sent.

Use `test.ping` when only transport/API credentials need to be checked.

## Troubleshooting

Common cases:

| Symptom | Likely cause |
| --- | --- |
| Real event not delivered | `enabled_events` does not include it |
| Event reports skipped | Selected monitor is outside `monitor_ids` |
| Channel active but no external request | Scope/event filter skipped it |
| HTTP 400/415 | Receiver rejected content type or payload |
| Timeout | Remote notification service is slow/unreachable |
| Missing signing secret | Worker Secret named by `secret_ref` is not configured |
| WPush/Telegram credential fails after ADMIN_TOKEN rotation | Re-enter directly stored encrypted credentials |

Recent delivery records can be inspected in D1:

```bash
wrangler d1 execute uptimer --local \
  --command="SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT 20;"
```

## Known limitations

- Built-in presets currently include Telegram and WPush; email is not built in.
- Custom payload template substitution produces strings.
- Payload template JSON nesting is capped.
- Monitor scope is id-based; renaming a monitor does not affect scope.

## Source code reference

| Component | File |
| --- | --- |
| Dispatch | `apps/worker/src/notify/webhook.ts` |
| Deduplication | `apps/worker/src/notify/dedupe.ts` |
| Template engine | `apps/worker/src/notify/template.ts` |
| Telegram token encryption | `apps/worker/src/notify/telegram-token.ts` |
| WPush key encryption | `apps/worker/src/notify/wpush-token.ts` |
| Config schema | `packages/db/src/json.ts` |
| Admin test endpoint | `apps/worker/src/routes/admin.ts` |
