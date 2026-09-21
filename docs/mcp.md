# Uptimer MCP

This fork exposes Uptimer management as a remote Model Context Protocol (MCP) server from the same Cloudflare Worker.

## Endpoint

Use either endpoint:

```text
https://<your-worker>.workers.dev/api/mcp
https://<your-worker>.workers.dev/api/v1/mcp
```

For this deployment, the default Worker URL is typically:

```text
https://uptimer.<your-workers-subdomain>.workers.dev/api/mcp
```

The MCP endpoint uses HTTP POST and Bearer authentication.

## Authentication

### Recommended: dedicated MCP token

Create a GitHub Actions repository secret:

```text
UPTIMER_MCP_TOKEN
```

Run **Deploy to Cloudflare** again. The workflow writes it to the Worker as the secret:

```text
MCP_TOKEN
```

Then configure the MCP client with:

```http
Authorization: Bearer <UPTIMER_MCP_TOKEN>
```

### Fallback

If `MCP_TOKEN` is not configured, the endpoint falls back to the existing Worker `ADMIN_TOKEN`.

This is convenient for initial testing, but a dedicated MCP token is recommended so MCP access can be rotated independently from the Admin dashboard.

## Protocol compatibility

The endpoint supports both MCP eras on the same URL:

- 2026 stateless requests, including `server/discover`
- 2025-era Streamable HTTP clients using `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`

The server does not require protocol sessions for its own tools.

## Tools

### Monitor management

| Tool | Purpose |
| --- | --- |
| `list_monitors` | List monitors, runtime state, SSL/domain settings, and Globalping config |
| `get_monitor` | Get one monitor by id |
| `create_monitor` | Create HTTP/TCP monitor |
| `update_monitor` | Update monitor fields |
| `delete_monitor` | Permanently delete a monitor; requires `confirm: true` |
| `test_monitor` | Run an immediate diagnostic test without writing normal uptime history |
| `pause_monitor` | Pause monitor |
| `resume_monitor` | Resume monitor |

`create_monitor` and `update_monitor` use the same validation rules as the Admin API. That includes:

- Globalping is HTTP/HTTPS only.
- Globalping mode requires `globalping_locations`.
- SSL checks require an HTTPS target.
- Domain warning thresholds and HTTP response assertions use the same Admin validation.

### Notifications

| Tool | Purpose |
| --- | --- |
| `list_notification_channels` | List notification channels with credentials sanitized |
| `set_notification_monitor_scope` | Restrict a channel to selected monitor ids, or clear the scope |
| `test_notification_channel` | Test connectivity or simulate monitor down/up/SSL/domain events |

Example scope:

```json
{
  "channel_id": 1,
  "monitor_ids": [1, 3]
}
```

An empty `monitor_ids` array restores the default "all monitors" behavior.

### Status and Globalping

| Tool | Purpose |
| --- | --- |
| `get_status` | Current Uptimer status |
| `get_globalping_status` | Latest per-region status/latency |
| `get_globalping_history` | 24-hour per-region history for one Globalping monitor |

## Examples

Create a Globalping monitor:

```json
{
  "name": "Google",
  "type": "http",
  "target": "https://www.google.com",
  "probe_mode": "globalping",
  "globalping_locations": ["Tokyo", "Singapore", "Frankfurt"],
  "ssl_check_enabled": true,
  "domain_name": "google.com"
}
```

Enable SSL/domain monitoring on an existing monitor:

```json
{
  "id": 1,
  "changes": {
    "ssl_check_enabled": true,
    "ssl_warn_days": 30,
    "domain_name": "example.com",
    "domain_warn_days": 30
  }
}
```

Simulate a notification event for one monitor:

```json
{
  "channel_id": 1,
  "event_type": "monitor.down",
  "monitor_id": 3
}
```

## Safety notes

- MCP has admin-level control over monitor configuration. Keep the Bearer token secret.
- `delete_monitor` requires an explicit `confirm: true`.
- Notification channel secrets are never returned by the MCP tools; responses reuse the existing sanitized Admin API.
- `test_monitor` is diagnostic and does not create normal uptime history.
- The MCP implementation intentionally reuses Uptimer's existing Admin/Public API paths rather than maintaining separate business rules.

## ChatGPT / remote MCP clients

Configure a remote MCP server with:

```text
URL: https://<your-worker>.workers.dev/api/mcp
Authorization: Bearer <your MCP token>
```

After connection, the client should discover the tools listed above. If the client only supports older Streamable HTTP MCP, use the same URL; no alternate endpoint is required.
