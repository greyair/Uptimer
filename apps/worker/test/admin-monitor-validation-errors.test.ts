import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/snapshots', () => ({
  refreshPublicHomepageSnapshotIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));

import type { Env } from '../src/env';
import { adminRoutes } from '../src/routes/admin';

describe('admin monitor validation errors', () => {
  it('returns structured 400 responses instead of a generic 500', async () => {
    const env = {
      DB: {} as D1Database,
      ADMIN_TOKEN: 'test-admin-token',
      ADMIN_RATE_LIMIT_MAX: '100',
      ADMIN_RATE_LIMIT_WINDOW_SEC: '60',
    } as Env;

    const response = await adminRoutes.fetch(
      new Request('https://status.example.com/monitors/5', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          globalping_locations: [''],
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
      },
    });
  });
});
