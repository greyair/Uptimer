import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/monitor/ssl', () => ({
  checkSslCertificate: vi.fn(),
}));
vi.mock('../src/monitor/rdap', () => ({
  checkDomainExpiry: vi.fn(),
}));

import { runDueAuxiliaryChecks } from '../src/monitor/auxiliary';
import { checkDomainExpiry } from '../src/monitor/rdap';
import { checkSslCertificate } from '../src/monitor/ssl';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

const DAY = 86_400;
const NOW = 2_000_000_000;

function createDb(row: Record<string, unknown>): D1Database {
  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'from monitor_extensions e join monitors m',
      all: () => [row],
    },
    {
      match: 'update monitor_extensions set ssl_last_checked_at',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'update monitor_extensions set domain_last_checked_at',
      run: () => ({ meta: { changes: 1 } }),
    },
  ];
  return createFakeD1Database(handlers);
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    monitor_id: 1,
    name: 'Homepage',
    target: 'https://example.com/health',
    display_url: 'https://example.com',
    ssl_check_enabled: 1,
    ssl_warn_days: 30,
    ssl_last_checked_at: null,
    domain_name: 'example.com',
    domain_warn_days: 30,
    domain_last_checked_at: null,
    ...overrides,
  };
}

describe('auxiliary expiry checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SSL and domain alerts when expiration is inside the warning window', async () => {
    vi.mocked(checkSslCertificate).mockResolvedValue({
      expiresAt: NOW + 10 * DAY,
      authorized: true,
      subject: 'CN=example.com',
      issuer: 'CN=Example CA',
      error: null,
    });
    vi.mocked(checkDomainExpiry).mockResolvedValue({
      expiresAt: NOW + 20 * DAY,
      rdapBase: 'https://rdap.example/',
      error: null,
    });

    const alerts = await runDueAuxiliaryChecks(createDb(baseRow()), NOW);

    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ssl',
          monitorId: 1,
          subject: 'example.com',
          daysRemaining: 10,
          warnDays: 30,
        }),
        expect.objectContaining({
          kind: 'domain',
          monitorId: 1,
          subject: 'example.com',
          daysRemaining: 20,
          warnDays: 30,
        }),
      ]),
    );
  });

  it('does not emit an alert when expiration is outside the warning window', async () => {
    vi.mocked(checkSslCertificate).mockResolvedValue({
      expiresAt: NOW + 90 * DAY,
      authorized: true,
      subject: 'CN=example.com',
      issuer: 'CN=Example CA',
      error: null,
    });
    vi.mocked(checkDomainExpiry).mockResolvedValue({
      expiresAt: NOW + 120 * DAY,
      rdapBase: 'https://rdap.example/',
      error: null,
    });

    const alerts = await runDueAuxiliaryChecks(createDb(baseRow()), NOW);
    expect(alerts).toEqual([]);
  });
});
