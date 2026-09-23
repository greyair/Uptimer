import { describe, expect, it } from 'vitest';

import {
  computeTodayPartialUptimeBatch,
  listHeartbeatsByMonitorId,
} from '../src/public/data';
import { readPublicMonitorRuntimeSnapshot } from '../src/public/monitor-runtime';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function runtimeSnapshot(intervalSec: number, generatedAt: number, lastCheckedAt = generatedAt) {
  return {
    version: 1 as const,
    generated_at: generatedAt,
    day_start_at: 0,
    monitors: [
      {
        monitor_id: 1,
        created_at: 0,
        interval_sec: intervalSec,
        range_start_at: 0,
        materialized_at: generatedAt,
        last_checked_at: lastCheckedAt,
        last_status_code: 'u' as const,
        last_outage_open: false,
        total_sec: generatedAt,
        downtime_sec: 0,
        unknown_sec: 0,
        uptime_sec: generatedAt,
        heartbeat_gap_sec: '',
        heartbeat_latency_ms: [25],
        heartbeat_status_codes: 'u',
      },
    ],
  };
}

function runtimeSnapshotHandler(snapshot: ReturnType<typeof runtimeSnapshot>): FakeD1QueryHandler {
  return {
    match: 'from public_snapshots',
    first: (args) => {
      if (args[0] !== 'monitor-runtime') return null;
      return {
        generated_at: snapshot.generated_at,
        updated_at: snapshot.generated_at,
        body_json: JSON.stringify(snapshot),
      };
    },
  };
}

describe('D1 read optimizations', () => {
  it('reads bounded heartbeats per monitor without a partition window scan', async () => {
    const seenSql: string[] = [];
    const db = createFakeD1Database([
      {
        match: 'select monitor_id, checked_at, status, latency_ms from check_results',
        all: (args, sql) => {
          seenSql.push(sql);
          const monitorId = Number(args[0]);
          return [
            {
              monitor_id: monitorId,
              checked_at: 1_000 - monitorId,
              status: 'up',
              latency_ms: 20 + monitorId,
            },
          ];
        },
      },
    ]);

    const result = await listHeartbeatsByMonitorId(db, [1, 2], 60);

    expect(result.get(1)).toEqual([
      { checked_at: 999, status: 'up', latency_ms: 21 },
    ]);
    expect(result.get(2)).toEqual([
      { checked_at: 998, status: 'up', latency_ms: 22 },
    ]);
    expect(seenSql).toHaveLength(2);
    expect(seenSql.every((sql) => sql.includes('where monitor_id = ?1'))).toBe(true);
    expect(seenSql.every((sql) => sql.includes('limit ?2'))).toBe(true);
    expect(seenSql.every((sql) => !sql.includes('row_number() over'))).toBe(true);
  });

  it('keeps a 5-minute runtime snapshot fresh through its scheduler cadence', async () => {
    const snapshot = runtimeSnapshot(300, 600);
    const db = createFakeD1Database([runtimeSnapshotHandler(snapshot)]);

    await expect(readPublicMonitorRuntimeSnapshot(db, 900)).resolves.toEqual(snapshot);
  });

  it('does not extend a 1-minute runtime snapshot beyond the default freshness window', async () => {
    const snapshot = runtimeSnapshot(60, 600);
    const db = createFakeD1Database([runtimeSnapshotHandler(snapshot)]);

    await expect(readPublicMonitorRuntimeSnapshot(db, 900)).resolves.toBeNull();
  });

  it('reuses a stale runtime snapshot when it still matches persisted monitor state', async () => {
    const snapshot = runtimeSnapshot(300, 300, 300);
    const db = createFakeD1Database([runtimeSnapshotHandler(snapshot)]);

    const totals = await computeTodayPartialUptimeBatch(
      db,
      [{ id: 1, interval_sec: 300, created_at: 0, last_checked_at: 300 }],
      0,
      900,
    );

    expect(totals.get(1)).toMatchObject({
      total_sec: 900,
      downtime_sec: 0,
    });
  });
});
