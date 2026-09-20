import type { Env } from '../env';

const MCP_SERVER_NAME = 'uptimer';
const MCP_SERVER_VERSION = '0.1.0';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

type McpRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
};

class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallError';
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ToolCallError(`${field} must be a positive integer`);
  }
  return value;
}

function asOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asPositiveInt(value, field);
}

function jsonHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
}

function serverMeta(): JsonObject {
  return {
    'io.modelcontextprotocol/serverInfo': {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
  };
}

function rpcResult(id: JsonRpcId, result: JsonObject, modern: boolean): Response {
  const body = {
    jsonrpc: '2.0',
    id,
    result: modern
      ? {
          ...result,
          resultType: 'complete',
          _meta: {
            ...(isRecord(result._meta) ? result._meta : {}),
            ...serverMeta(),
          },
        }
      : result,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: jsonHeaders(),
  });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    }),
    {
      status,
      headers: jsonHeaders(),
    },
  );
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      message: 'A valid Bearer token is required for the Uptimer MCP endpoint.',
    }),
    {
      status: 401,
      headers: jsonHeaders({
        'WWW-Authenticate': 'Bearer realm="Uptimer MCP"',
      }),
    },
  );
}

function expectedMcpToken(env: Env): string {
  return env.MCP_TOKEN?.trim() || env.ADMIN_TOKEN?.trim() || '';
}

function hasValidMcpToken(request: Request, env: Env): boolean {
  const expected = expectedMcpToken(env);
  if (!expected) return false;
  const authorization = request.headers.get('Authorization')?.trim() ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return false;
  return authorization.slice(7).trim() === expected;
}

function isModernRequest(request: Request, body: McpRequest): boolean {
  if (request.headers.get('MCP-Protocol-Version') === MODERN_PROTOCOL_VERSION) return true;
  if (!isRecord(body.params)) return false;
  const meta = body.params._meta;
  if (!isRecord(meta)) return false;
  return meta['io.modelcontextprotocol/protocolVersion'] === MODERN_PROTOCOL_VERSION;
}

function validateModernHeaders(request: Request, body: McpRequest): string | null {
  if (!isModernRequest(request, body)) return null;

  const protocol = request.headers.get('MCP-Protocol-Version');
  if (protocol && protocol !== MODERN_PROTOCOL_VERSION) {
    return `Unsupported MCP protocol version: ${protocol}`;
  }

  const method = typeof body.method === 'string' ? body.method : '';
  const methodHeader = request.headers.get('Mcp-Method');
  if (methodHeader && methodHeader !== method) {
    return 'Mcp-Method header does not match JSON-RPC method';
  }

  if (method === 'tools/call' && isRecord(body.params)) {
    const name = typeof body.params.name === 'string' ? body.params.name : '';
    const nameHeader = request.headers.get('Mcp-Name');
    if (nameHeader && nameHeader !== name) {
      return 'Mcp-Name header does not match params.name';
    }
  }

  return null;
}

async function parseApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    if (isRecord(parsed)) {
      const nestedError = parsed.error;
      if (isRecord(nestedError) && typeof nestedError.message === 'string') {
        message = nestedError.message;
      } else if (typeof parsed.message === 'string') {
        message = parsed.message;
      }
    } else if (typeof parsed === 'string' && parsed.trim()) {
      message = parsed.trim();
    }
    throw new ToolCallError(message);
  }

  return parsed;
}

async function callAdminApi(
  env: Env,
  ctx: ExecutionContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const { adminRoutes } = await import('../routes/admin');
  const headers = new Headers({
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
  });
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  }

  const response = await adminRoutes.fetch(
    new Request(`https://uptimer.internal${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    env,
    ctx,
  );

  return parseApiResponse(response);
}

async function callPublicApi(
  env: Env,
  ctx: ExecutionContext,
  router: 'public' | 'ui',
  path: string,
): Promise<unknown> {
  const headers = new Headers({
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
  });
  const request = new Request(`https://uptimer.internal${path}`, { headers });

  const response =
    router === 'public'
      ? await (await import('../routes/public')).publicRoutes.fetch(request, env, ctx)
      : await (await import('../routes/public-ui')).publicUiRoutes.fetch(request, env, ctx);

  return parseApiResponse(response);
}

const monitorProperties: JsonObject = {
  name: { type: 'string', minLength: 1 },
  type: { type: 'string', enum: ['http', 'tcp'] },
  target: { type: 'string', minLength: 1 },
  display_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  interval_sec: { type: 'integer', minimum: 60 },
  timeout_ms: { type: 'integer', minimum: 1000 },
  http_method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
  http_headers_json: { type: 'object', additionalProperties: { type: 'string' } },
  http_body: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  follow_redirects: { type: 'boolean' },
  expected_status_json: {},
  forbidden_status_json: {},
  response_keyword: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  response_keyword_mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  response_forbidden_keyword: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  response_forbidden_keyword_mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  group_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  group_sort_order: { type: 'integer' },
  sort_order: { type: 'integer' },
  show_on_status_page: { type: 'boolean' },
  is_active: { type: 'boolean' },
  probe_mode: { type: 'string', enum: ['direct', 'globalping'] },
  globalping_locations: {
    anyOf: [
      {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', minLength: 1 },
      },
      { type: 'null' },
    ],
  },
  ssl_check_enabled: { type: 'boolean' },
  ssl_warn_days: { type: 'integer', minimum: 1, maximum: 365 },
  domain_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  domain_warn_days: { type: 'integer', minimum: 1, maximum: 365 },
};

const tools: ToolDefinition[] = [
  {
    name: 'list_monitors',
    description: 'List Uptimer monitors with runtime state and extended SSL/domain/Globalping settings.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_monitor',
    description: 'Get one monitor by numeric id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_monitor',
    description:
      'Create an HTTP or TCP monitor. For Globalping, set probe_mode=globalping and provide globalping_locations.',
    inputSchema: {
      type: 'object',
      properties: monitorProperties,
      required: ['name', 'type', 'target'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_monitor',
    description: 'Update an existing monitor using the same fields accepted by the Uptimer admin API.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        changes: {
          type: 'object',
          properties: monitorProperties,
          minProperties: 1,
          additionalProperties: false,
        },
      },
      required: ['id', 'changes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'delete_monitor',
    description: 'Delete a monitor permanently. confirm must be true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        confirm: { const: true },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'test_monitor',
    description: 'Run an immediate diagnostic monitor test without writing it into normal uptime history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pause_monitor',
    description: 'Pause a monitor.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'resume_monitor',
    description: 'Resume a paused monitor.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_notification_channels',
    description:
      'List notification channels. Secret credentials are sanitized by the existing Uptimer admin API.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_notification_monitor_scope',
    description:
      'Set the monitor ids a notification channel applies to. Use an empty monitor_ids array to notify for all monitors.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'integer', minimum: 1 },
        monitor_ids: {
          type: 'array',
          uniqueItems: true,
          maxItems: 200,
          items: { type: 'integer', minimum: 1 },
        },
      },
      required: ['channel_id', 'monitor_ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'test_notification_channel',
    description:
      'Test a notification channel. Optionally simulate a monitor event and monitor id to verify monitor-scope filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'integer', minimum: 1 },
        event_type: {
          type: 'string',
          enum: [
            'test.ping',
            'monitor.down',
            'monitor.up',
            'monitor.ssl.expiring',
            'monitor.domain.expiring',
          ],
          default: 'test.ping',
        },
        monitor_id: { type: 'integer', minimum: 1 },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'get_status',
    description: 'Get the current Uptimer public status payload, including hidden monitors for this admin-level MCP connection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_globalping_status',
    description: 'Get the latest per-region Globalping status and latency for Globalping monitors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_globalping_history',
    description: 'Get the latest 24-hour per-region Globalping history for one monitor.',
    inputSchema: {
      type: 'object',
      properties: { monitor_id: { type: 'integer', minimum: 1 } },
      required: ['monitor_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

async function listMonitors(env: Env, ctx: ExecutionContext, limit = 50): Promise<unknown> {
  return callAdminApi(env, ctx, `/monitors?limit=${encodeURIComponent(String(limit))}`);
}

async function callTool(
  name: string,
  args: JsonObject,
  env: Env,
  ctx: ExecutionContext,
): Promise<unknown> {
  switch (name) {
    case 'list_monitors': {
      const rawLimit = args.limit;
      const limit =
        typeof rawLimit === 'number' && Number.isInteger(rawLimit)
          ? Math.max(1, Math.min(200, rawLimit))
          : 50;
      return listMonitors(env, ctx, limit);
    }

    case 'get_monitor': {
      const id = asPositiveInt(args.id, 'id');
      const listed = await listMonitors(env, ctx, 200);
      if (!isRecord(listed) || !Array.isArray(listed.monitors)) {
        throw new ToolCallError('Unexpected monitor list response');
      }
      const monitor = listed.monitors.find(
        (item) => isRecord(item) && item.id === id,
      );
      if (!monitor) throw new ToolCallError(`Monitor #${id} not found`);
      return { monitor };
    }

    case 'create_monitor':
      return callAdminApi(env, ctx, '/monitors', { method: 'POST', body: args });

    case 'update_monitor': {
      const id = asPositiveInt(args.id, 'id');
      if (!isRecord(args.changes) || Object.keys(args.changes).length === 0) {
        throw new ToolCallError('changes must be a non-empty object');
      }
      return callAdminApi(env, ctx, `/monitors/${id}`, {
        method: 'PATCH',
        body: args.changes,
      });
    }

    case 'delete_monitor': {
      const id = asPositiveInt(args.id, 'id');
      if (args.confirm !== true) {
        throw new ToolCallError('confirm must be true to delete a monitor');
      }
      return callAdminApi(env, ctx, `/monitors/${id}`, { method: 'DELETE' });
    }

    case 'test_monitor': {
      const id = asPositiveInt(args.id, 'id');
      return callAdminApi(env, ctx, `/monitors/${id}/test`, { method: 'POST' });
    }

    case 'pause_monitor': {
      const id = asPositiveInt(args.id, 'id');
      return callAdminApi(env, ctx, `/monitors/${id}/pause`, { method: 'POST' });
    }

    case 'resume_monitor': {
      const id = asPositiveInt(args.id, 'id');
      return callAdminApi(env, ctx, `/monitors/${id}/resume`, { method: 'POST' });
    }

    case 'list_notification_channels':
      return callAdminApi(env, ctx, '/notification-channels');

    case 'set_notification_monitor_scope': {
      const channelId = asPositiveInt(args.channel_id, 'channel_id');
      if (!Array.isArray(args.monitor_ids)) {
        throw new ToolCallError('monitor_ids must be an array');
      }
      const monitorIds = args.monitor_ids.map((id, index) =>
        asPositiveInt(id, `monitor_ids[${index}]`),
      );

      const listed = await callAdminApi(env, ctx, '/notification-channels');
      if (!isRecord(listed) || !Array.isArray(listed.notification_channels)) {
        throw new ToolCallError('Unexpected notification channel list response');
      }
      const channel = listed.notification_channels.find(
        (item) => isRecord(item) && item.id === channelId,
      );
      if (!isRecord(channel) || !isRecord(channel.config_json)) {
        throw new ToolCallError(`Notification channel #${channelId} not found`);
      }

      const config = {
        ...channel.config_json,
        ...(monitorIds.length > 0 ? { monitor_ids: monitorIds } : { monitor_ids: undefined }),
      };
      if (monitorIds.length === 0) delete config.monitor_ids;

      return callAdminApi(env, ctx, `/notification-channels/${channelId}`, {
        method: 'PATCH',
        body: { config_json: config },
      });
    }

    case 'test_notification_channel': {
      const channelId = asPositiveInt(args.channel_id, 'channel_id');
      const eventType =
        typeof args.event_type === 'string' ? args.event_type : 'test.ping';
      const monitorId = asOptionalPositiveInt(args.monitor_id, 'monitor_id');
      return callAdminApi(env, ctx, `/notification-channels/${channelId}/test`, {
        method: 'POST',
        body: {
          event_type: eventType,
          ...(monitorId === undefined ? {} : { monitor_id: monitorId }),
        },
      });
    }

    case 'get_status':
      return callPublicApi(env, ctx, 'public', '/status');

    case 'get_globalping_status':
      return callPublicApi(env, ctx, 'ui', '/globalping-status');

    case 'get_globalping_history': {
      const monitorId = asPositiveInt(args.monitor_id, 'monitor_id');
      return callPublicApi(
        env,
        ctx,
        'ui',
        `/monitors/${monitorId}/globalping-history?range=24h`,
      );
    }

    default:
      throw new ToolCallError(`Unknown tool: ${name}`);
  }
}

function toolResult(value: unknown, modern: boolean): JsonObject {
  const structuredContent = isRecord(value) ? value : { value };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent,
    ...(modern ? {} : {}),
  };
}

function toolErrorResult(message: string): JsonObject {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requestedLegacyProtocol(params: unknown): string {
  if (!isRecord(params) || typeof params.protocolVersion !== 'string') {
    return LEGACY_PROTOCOL_VERSION;
  }
  return params.protocolVersion === MODERN_PROTOCOL_VERSION
    ? LEGACY_PROTOCOL_VERSION
    : params.protocolVersion;
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST, OPTIONS' },
    });
  }

  if (!hasValidMcpToken(request, env)) {
    return unauthorized();
  }

  let body: McpRequest;
  try {
    const parsed = (await request.json()) as unknown;
    if (!isRecord(parsed)) {
      return rpcError(null, -32600, 'Invalid Request', 400);
    }
    body = parsed as McpRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }

  const id = body.id ?? null;
  const modern = isModernRequest(request, body);
  const headerError = validateModernHeaders(request, body);
  if (headerError) {
    return rpcError(id, -32020, headerError, 400);
  }

  const method = typeof body.method === 'string' ? body.method : '';
  if (!method) {
    return rpcError(id, -32600, 'Invalid Request', 400);
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }

  if (method === 'server/discover') {
    return rpcResult(
      id,
      {
        supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        instructions:
          'Manage Uptimer monitors, Globalping probes, SSL/domain monitoring, and notification channel scopes.',
        ttlMs: 300_000,
        cacheScope: 'private',
      },
      true,
    );
  }

  if (method === 'initialize') {
    return rpcResult(
      id,
      {
        protocolVersion: requestedLegacyProtocol(body.params),
        capabilities: { tools: {} },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
        },
        instructions:
          'Manage Uptimer monitors, Globalping probes, SSL/domain monitoring, and notification channel scopes.',
      },
      false,
    );
  }

  if (method === 'ping') {
    return rpcResult(id, {}, modern);
  }

  if (method === 'tools/list') {
    return rpcResult(
      id,
      {
        tools,
        ...(modern ? { ttlMs: 300_000, cacheScope: 'private' } : {}),
      },
      modern,
    );
  }

  if (method === 'tools/call') {
    if (!isRecord(body.params) || typeof body.params.name !== 'string') {
      return rpcError(id, -32602, 'Invalid params: tool name is required');
    }
    const args = isRecord(body.params.arguments) ? body.params.arguments : {};

    try {
      const value = await callTool(body.params.name, args, env, ctx);
      return rpcResult(id, toolResult(value, modern), modern);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcResult(id, toolErrorResult(message), modern);
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
