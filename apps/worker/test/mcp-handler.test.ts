import { describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import { handleMcpRequest } from '../src/mcp/handler';

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    ADMIN_TOKEN: 'admin-token',
    MCP_TOKEN: 'mcp-token',
  } as Env;
}

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('MCP handler', () => {
  it('requires a bearer token', async () => {
    const response = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      }),
      createEnv(),
      ctx(),
    );

    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: 'unauthorized' });
  });

  it('serves legacy initialize and tools/list on the same endpoint', async () => {
    const env = createEnv();
    const initialize = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcp-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      }),
      env,
      ctx(),
    );
    expect(initialize.status).toBe(200);
    expect(await json(initialize)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'uptimer', version: '0.1.0' },
      },
    });

    const list = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcp-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      }),
      env,
      ctx(),
    );
    const listBody = await json(list);
    const result = listBody.result as { tools?: Array<{ name?: string }> };
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      'list_monitors',
      'get_monitor',
      'create_monitor',
      'update_monitor',
      'delete_monitor',
      'test_monitor',
      'pause_monitor',
      'resume_monitor',
      'list_notification_channels',
      'set_notification_monitor_scope',
      'test_notification_channel',
      'get_status',
      'get_globalping_status',
      'get_globalping_history',
    ]);
  });

  it('supports 2026 server/discover and validates routing headers', async () => {
    const env = createEnv();
    const params = {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
      },
    };

    const response = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcp-token',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'server/discover',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'server/discover',
          params,
        }),
      }),
      env,
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 10,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        resultType: 'complete',
      },
    });

    const mismatch = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcp-token',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'server/discover',
          params,
        }),
      }),
      env,
      ctx(),
    );

    expect(mismatch.status).toBe(400);
    expect(await json(mismatch)).toMatchObject({
      error: { code: -32020 },
    });
  });

  it('returns MCP tool errors in-band for unknown tools', async () => {
    const response = await handleMcpRequest(
      new Request('https://uptimer.example/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer mcp-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'does_not_exist', arguments: {} },
        }),
      }),
      createEnv(),
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text' }],
      },
    });
  });
});
