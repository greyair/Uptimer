import { describe, expect, it } from 'vitest';

import type { Env } from '../src/env';
import {
  readInternalScheduledBatchSize,
  readProfileBoolean,
  readPublicSnapshotFreshnessSeconds,
  readUptimerProfile,
} from '../src/config/profile';

function env(values: Record<string, string> = {}): Env {
  return values as unknown as Env;
}

describe('runtime profiles', () => {
  it('uses balanced defaults when no profile is configured', () => {
    const value = env();
    expect(readUptimerProfile(value)).toBe('balanced');
    expect(readPublicSnapshotFreshnessSeconds(value)).toBe(60);
    expect(readInternalScheduledBatchSize(value)).toBe(6);
    expect(readProfileBoolean(value, 'UPTIMER_PUBLIC_SHARDED_ASSEMBLER')).toBe(false);
  });

  it('uses low-write defaults for small deployments', () => {
    const value = env({ UPTIMER_PROFILE: 'low-write' });
    expect(readPublicSnapshotFreshnessSeconds(value)).toBe(300);
    expect(readInternalScheduledBatchSize(value)).toBe(6);
    expect(readProfileBoolean(value, 'UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES')).toBe(false);
    expect(readProfileBoolean(value, 'UPTIMER_SCHEDULED_SHARDED_CONTINUATION')).toBe(false);
  });

  it('enables the sharded pipeline in high-scale profile', () => {
    const value = env({ UPTIMER_PROFILE: 'high-scale' });
    expect(readInternalScheduledBatchSize(value)).toBe(2);
    expect(readProfileBoolean(value, 'UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES')).toBe(true);
    expect(readProfileBoolean(value, 'UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH')).toBe(true);
    expect(readProfileBoolean(value, 'UPTIMER_PUBLIC_SHARDED_ASSEMBLER')).toBe(true);
    expect(readProfileBoolean(value, 'UPTIMER_SCHEDULED_SHARDED_CONTINUATION')).toBe(true);
  });

  it('lets explicit environment variables override profile defaults', () => {
    const value = env({
      UPTIMER_PROFILE: 'high-scale',
      UPTIMER_PUBLIC_SHARDED_ASSEMBLER: '0',
      UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE: '5',
      UPTIMER_PUBLIC_SNAPSHOT_FRESHNESS_SECONDS: '420',
    });
    expect(readProfileBoolean(value, 'UPTIMER_PUBLIC_SHARDED_ASSEMBLER')).toBe(false);
    expect(readInternalScheduledBatchSize(value)).toBe(5);
    expect(readPublicSnapshotFreshnessSeconds(value)).toBe(420);
  });

  it('falls back safely for unknown profiles', () => {
    const value = env({ UPTIMER_PROFILE: 'mystery' });
    expect(readUptimerProfile(value)).toBe('balanced');
    expect(readPublicSnapshotFreshnessSeconds(value)).toBe(60);
  });
});
