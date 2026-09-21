# 通知系统

[English](notifications.md) | 中文

Uptimer 会在监控状态变化、Incident / Maintenance 生命周期变化，以及 SSL/域名到期预警时发送通知。

当前 fork 支持三种通知渠道：

- **Custom Webhook**
- **Telegram 预设**
- **WPush 预设**

完整的 fork 与 upstream 差异请见 [Fork Differences](fork-differences.md)。

## 事件类型

| 事件 | 说明 |
| --- | --- |
| `monitor.down` | 监控项进入 DOWN |
| `monitor.up` | 监控项恢复 UP |
| `monitor.ssl.expiring` | SSL 证书进入预警时间范围 |
| `monitor.domain.expiring` | 域名注册到期时间进入预警范围 |
| `incident.created` | 创建 Incident |
| `incident.updated` | Incident 更新 |
| `incident.resolved` | Incident 已解决 |
| `maintenance.started` | 维护窗口开始 |
| `maintenance.ended` | 维护窗口结束 |
| `test.ping` | 测试通知渠道连接/配置 |

## 投递流程

1. 系统产生 `eventType`、`eventKey` 和 payload。
2. 读取所有启用的通知渠道。
3. 每个渠道依次按以下条件过滤：
   - `enabled_events`
   - 可选的 `monitor_ids`
4. 在 `notification_deliveries` 中 claim 一次投递。
5. 渲染消息和 payload。
6. 发出请求。
7. 记录 success / failed。

`test.ping` 始终绕过事件和监控对象过滤，便于单独验证通知服务是否可用。

## 幂等去重

`notification_deliveries` 用于防止同一个事件重复发送给同一渠道。

示例：

```text
monitor:<monitorId>:down:<timestamp>
monitor:<monitorId>:up:<timestamp>
monitor:<monitorId>:ssl-expiring:<expiresAt>:<warnDays>
monitor:<monitorId>:domain-expiring:<expiresAt>:<warnDays>
```

证书/域名续期，或修改预警天数后，会自然生成新的到期事件 key。

## 管理端 API

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/admin/notification-channels` | 查询渠道 |
| POST | `/api/v1/admin/notification-channels` | 创建渠道 |
| PATCH | `/api/v1/admin/notification-channels/:id` | 修改渠道 |
| DELETE | `/api/v1/admin/notification-channels/:id` | 删除渠道 |
| POST | `/api/v1/admin/notification-channels/:id/test` | 测试渠道 |

测试接口支持：

```text
test.ping
monitor.down
monitor.up
monitor.ssl.expiring
monitor.domain.expiring
```

测试监控事件时可以指定监控 ID。返回结果会明确表示是否真正发送，或因为 monitor scope 被标记为 **skipped**。

## 通用渠道字段

不同渠道按适用情况支持：

| 字段 | 说明 |
| --- | --- |
| `timeout_ms` | 请求超时 |
| `message_template` | 消息模板 |
| `enabled_events` | 事件白名单；空/不设置表示全部 |
| `monitor_ids` | 可选监控对象范围；空/不设置表示全部监控 |

### 监控对象范围

示例：

```json
{
  "monitor_ids": [1, 3]
}
```

规则：

- 不设置或空数组：全部监控
- monitor 事件：monitor id 必须在范围内
- Incident / Maintenance：关联监控中至少有一个匹配
- `test.ping`：始终允许

## Custom Webhook

Custom Webhook 支持：

- URL
- GET / POST / PUT / PATCH / DELETE / HEAD
- 自定义 Headers
- 超时
- Payload 类型：
  - `json`
  - `param`
  - `x-www-form-urlencoded`
- 消息模板
- Payload 模板
- 事件过滤
- monitor scope
- 可选 HMAC-SHA256 签名

### 默认 JSON

不设置自定义 Payload 模板时，会直接发送系统事件 payload，例如：

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

### 模板语法

示例：

```text
{{event}}
{{monitor.name}}
{{state.status}}
{{checks[0].latency_ms}}
$MSG
```

不存在的路径会渲染为空字符串。

模板禁止访问 `__proto__`、`prototype`、`constructor`。

模板替换最终生成字符串。如果必须保留数字类型，应使用默认 payload，而不是字符串模板替换。

### HMAC 签名

启用签名后：

```text
X-Uptimer-Timestamp: <unix_seconds>
X-Uptimer-Signature: sha256=<hmac_hex>
```

签名内容：

```text
<timestamp>.<rawBody>
```

Secret 从 `secret_ref` 指定的 Worker Secret 中读取。

## Telegram 预设

Telegram 是内置预设，支持：

- 直接输入 Bot Token，并在保存前加密
- Worker Secret 引用
- Chat ID
- 可选 Message Thread ID
- Parse Mode
- 静默/内容保护选项
- 超时
- 消息模板
- 事件过滤
- monitor scope

直接输入的 Token 不会以明文存储，Admin API 也不会返回密文。

## WPush 预设

WPush 是本 fork 的扩展功能，已经作为 upstream PR #103 提交。

发送方式：

```text
POST https://api.wpush.cn/api/v1/send
Content-Type: application/x-www-form-urlencoded
```

支持：

- 直接输入 API Key，并在保存前加密
- Worker Secret 引用
- `channel`
- 可选 `option`
- 可选 URL
- 超时
- 标题模板
- 消息模板
- 事件过滤
- monitor scope

示例：

```json
{
  "preset": "wpush",
  "api_key_secret_ref": "UPTIMER_WPUSH_API_KEY",
  "channel": "wechat",
  "option": "ops"
}
```

直接输入的 API Key 使用从 `ADMIN_TOKEN` 派生的密钥进行 AES-GCM 加密。

如果更换 `ADMIN_TOKEN`，之前使用旧 token 加密保存的 Telegram/WPush 凭证需要重新输入。

## 测试 monitor scope

管理后台可以直接测试一个实际的监控事件，而不是只能发 `test.ping`。

例如：

```json
{
  "event_type": "monitor.down",
  "monitor_id": 3
}
```

如果 monitor #3 不在该通知渠道配置的范围内，结果会显示 **skipped**，并且不会向外部通知服务发送请求。

只测试通知服务连接/API Key 时，使用 `test.ping`。

## 故障排除

| 现象 | 常见原因 |
| --- | --- |
| 真实事件没有发送 | `enabled_events` 没包含该事件 |
| 测试结果显示 skipped | 选择的监控不在 `monitor_ids` 范围 |
| 渠道启用但没有外部请求 | 被事件/监控对象过滤 |
| HTTP 400/415 | 对方拒绝 Content-Type 或 payload |
| Timeout | 通知服务超时/不可达 |
| Signing secret missing | `secret_ref` 对应 Worker Secret 没设置 |
| 更换 ADMIN_TOKEN 后 Telegram/WPush 失败 | 重新输入原来直接保存的加密凭证 |

本地 D1 查看最近投递记录：

```bash
wrangler d1 execute uptimer --local \
  --command="SELECT * FROM notification_deliveries ORDER BY created_at DESC LIMIT 20;"
```

## 已知限制

- 当前内置预设包括 Telegram 和 WPush；暂未内置 Email。
- 自定义 Payload 模板替换最终都是字符串。
- Payload 模板 JSON 嵌套深度有限制。
- monitor scope 基于 monitor ID，修改监控名称不会影响范围。

## 源码参考

| 组件 | 文件 |
| --- | --- |
| 通知派发 | `apps/worker/src/notify/webhook.ts` |
| 幂等去重 | `apps/worker/src/notify/dedupe.ts` |
| 模板引擎 | `apps/worker/src/notify/template.ts` |
| Telegram Token 加密 | `apps/worker/src/notify/telegram-token.ts` |
| WPush API Key 加密 | `apps/worker/src/notify/wpush-token.ts` |
| 配置 Schema | `packages/db/src/json.ts` |
| 测试接口 | `apps/worker/src/routes/admin.ts` |
