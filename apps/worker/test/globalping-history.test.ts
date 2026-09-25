import { describe, expect, it } from 'vitest';

import {
  GLOBALPING_HISTORY_INTERVAL_SECONDS,
  shouldPersistGlobalpingHistory,
} from '../src/monitor/globalping-history';

const stable = [
  { location: 'Tokyo, JP', status: 'up' as const, latencyMs: 42, httpStatus: 200, error: null },
  { location: 'Singapore, SG', status: 'up' as const, latencyMs: 51, httpStatus: 200, error: null },
];

describe('Globalping history downsampling policy', () => {
  it('persists the first history sample', () => {
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_000,
      lastHistoryWrittenAt: null,
      previousResultsJson: null,
      currentResults: stable,
    })).toBe(true);
  });

  it('skips stable samples inside the 15-minute cadence', () => {
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_600,
      lastHistoryWrittenAt: 10_000,
      previousResultsJson: JSON.stringify(stable),
      currentResults: stable.map((item) => ({ ...item, latencyMs: (item.latencyMs ?? 0) + 8 })),
    })).toBe(false);
  });

  it('persists stable samples at the cadence boundary', () => {
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_000 + GLOBALPING_HISTORY_INTERVAL_SECONDS,
      lastHistoryWrittenAt: 10_000,
      previousResultsJson: JSON.stringify(stable),
      currentResults: stable,
    })).toBe(true);
  });

  it('persists a regional failure immediately', () => {
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_300,
      lastHistoryWrittenAt: 10_000,
      previousResultsJson: JSON.stringify(stable),
      currentResults: [{ ...stable[0]!, status: 'down', error: 'timeout' }, stable[1]!],
    })).toBe(true);
  });

  it('persists recovery immediately', () => {
    const failed = [{ ...stable[0]!, status: 'down' as const, error: 'timeout' }, stable[1]!];
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_300,
      lastHistoryWrittenAt: 10_000,
      previousResultsJson: JSON.stringify(failed),
      currentResults: stable,
    })).toBe(true);
  });

  it('persists error appearance even when status is unchanged', () => {
    expect(shouldPersistGlobalpingHistory({
      checkedAt: 10_300,
      lastHistoryWrittenAt: 10_000,
      previousResultsJson: JSON.stringify(stable),
      currentResults: [{ ...stable[0]!, error: 'partial probe error' }, stable[1]!],
    })).toBe(true);
  });
});
