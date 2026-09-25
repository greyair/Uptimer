import { writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi.fn(),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));

import type { Env } from '../src/env';
import { runScheduledTick } from '../src/scheduler/scheduled';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

type Scenario = {
  name: string;
  monitorCount: number;
  dueCount: number;
  schedule: 'staggered' | 'burst';
  profile: 'low-write' | 'balanced' | 'high-scale';
  withChannel: boolean;
};

type Sample = {
  elapsedMs: number;
  batchCalls: number;
  statementCount: number;
  waitUntilCalls: number;
};

const BENCH_LABEL = process.env.SCHEDULER_BENCH_LABEL ?? 'current-working-tree';
const OUTPUT_PATH = process.env.SCHEDULER_BENCH_OUTPUT ?? null;

const MONITOR_COUNTS = [10, 25, 50] as const;
const PROFILES = ['low-write', 'balanced', 'high-scale'] as const;

const SCENARIOS: Scenario[] = PROFILES.flatMap((profile) =>
  MONITOR_COUNTS.flatMap((monitorCount) => {
    // Production monitors are close to a five-minute cadence. A staggered minute
    // therefore has roughly one fifth of the fleet due, while burst models the
    // worst case where the whole fleet becomes due on the same Cron tick.
    const staggeredDueCount = Math.max(1, Math.ceil(monitorCount / 5));
    return [
      {
        name: `${profile} / ${monitorCount} monitors / staggered (${staggeredDueCount} due)`,
        monitorCount,
        dueCount: staggeredDueCount,
        schedule: 'staggered' as const,
        profile,
        withChannel: false,
      },
      {
        name: `${profile} / ${monitorCount} monitors / burst (all due)`,
        monitorCount,
        dueCount: monitorCount,
        schedule: 'burst' as const,
        profile,
        withChannel: false,
      },
    ];
  }),
);

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

const WARMUP_RUNS = parsePositiveIntEnv('SCHEDULER_BENCH_WARMUPS', 3);
const MEASURE_RUNS = parsePositiveIntEnv('SCHEDULER_BENCH_RUNS', 12);

function makeDueRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Monitor ${index + 1}`,
    type: 'unsupported',
    target: `benchmark-target-${index + 1}`,
    group_name: index % 2 === 0 ? 'Core' : 'Edge',
    interval_sec: 60,
    created_at: 1_700_000_000 - 40 * 86_400,
    timeout_ms: 5000,
    http_method: null,
    http_headers_json: null,
    http_body: null,
    expected_status_json: null,
    forbidden_status_json: null,
    response_keyword: null,
    response_keyword_mode: null,
    response_forbidden_keyword: null,
    response_forbidden_keyword_mode: null,
    state_status: 'up',
    state_last_error: null,
    last_changed_at: 1_700_000_000,
    consecutive_failures: 0,
    consecutive_successes: 3,
  }));
}

function createEnvForScenario(scenario: Scenario): {
  env: Env;
  sampleState: Omit<Sample, 'elapsedMs'>;
} {
  const sampleState = {
    batchCalls: 0,
    statementCount: 0,
    waitUntilCalls: 0,
  };
  const allRows = makeDueRows(scenario.monitorCount);
  const dueRows = allRows.slice(0, scenario.dueCount);
  let homepageArtifactGeneratedAt = 0;
  const channels = scenario.withChannel
    ? [
        {
          id: 1,
          name: 'primary',
          config_json: JSON.stringify({
            url: 'https://hooks.example.com/uptimer',
            method: 'POST',
            payload_type: 'json',
          }),
          created_at: 1_700_000_000,
        },
      ]
    : [];

  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'insert into locks',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'from notification_channels',
      all: () => channels,
    },
    {
      match: 'select key, value from settings',
      all: () => [
        { key: 'site_title', value: 'Status Hub' },
        { key: 'site_description', value: 'Production services' },
        { key: 'site_locale', value: 'en' },
        { key: 'site_timezone', value: 'UTC' },
        { key: 'uptime_rating_level', value: '3' },
      ],
    },
    {
      match: 'from monitors m',
      all: (args, normalizedSql) => {
        if (normalizedSql.includes('limit ?1')) {
          return dueRows.slice(0, Number(args[0] ?? dueRows.length));
        }
        return dueRows;
      },
    },
    {
      match: 'select distinct mwm.monitor_id',
      all: () => [],
    },
    {
      match: 'from maintenance_windows',
      all: () => [],
    },
    {
      match: 'from maintenance_window_monitors',
      all: () => [],
    },
    {
      match: 'with active_maintenance',
      first: () => ({
        monitor_count_total: dueRows.length,
        up: dueRows.length,
        down: 0,
        maintenance: 0,
        paused: 0,
        unknown: 0,
      }),
    },
    {
      // The P1 runtime uses the bounded per-monitor heartbeat query, while
      // older benchmark fixtures only modeled the previous ROW_NUMBER form.
      // Keep both shapes in the shared P2 harness so baseline and current
      // implementations are measured against identical synthetic data.
      match: (sql) =>
        sql.includes('from check_results') &&
        sql.includes('where monitor_id = ?1') &&
        sql.includes('order by checked_at desc, id desc') &&
        sql.includes('limit ?2'),
      all: (args) => {
        const monitorId = Number(args[0] ?? 0);
        const limit = Math.max(0, Number(args[1] ?? 30));
        return Array.from({ length: limit }, (_, index) => ({
          monitor_id: monitorId,
          checked_at: 1_700_000_000 - (index + 1) * 60,
          status: 'up',
          latency_ms: 40 + ((monitorId + index) % 50),
        }));
      },
    },
    {
      match: 'row_number() over',
      all: () =>
        dueRows.slice(0, 12).flatMap((row) =>
          Array.from({ length: 30 }, (_, index) => ({
            monitor_id: row.id,
            checked_at: 1_700_000_000 - (index + 1) * 60,
            status: 'up',
            latency_ms: 40 + ((row.id + index) % 50),
          })),
        ),
    },
    {
      match: 'from monitor_daily_rollups',
      all: () =>
        dueRows.slice(0, 12).flatMap((row) =>
          Array.from({ length: 14 }, (_, index) => ({
            monitor_id: row.id,
            day_start_at: 1_700_000_000 - (14 - index) * 86_400,
            total_sec: 86_400,
            downtime_sec: 0,
            unknown_sec: 0,
            uptime_sec: 86_400,
          })),
        ),
    },
    {
      // P1's legacy today-uptime fallback reads overlapping outages when a
      // runtime snapshot must be rebuilt. Stable synthetic monitors have none.
      match: 'from outages',
      all: () => [],
    },
    {
      // The same P1 fallback reads the current-day check stream in one
      // monitor-id batch. Return stable "up" checks for the requested ids.
      match: (sql) =>
        sql.includes('from check_results') &&
        sql.includes('where monitor_id in (') &&
        sql.includes('and checked_at >=') &&
        sql.includes('and checked_at <') &&
        sql.includes('order by monitor_id, checked_at'),
      all: (args) => {
        const monitorIds = args
          .slice(0, Math.max(0, args.length - 2))
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value));
        return monitorIds.flatMap((monitorId) =>
          Array.from({ length: 12 }, (_, index) => ({
            monitor_id: monitorId,
            checked_at: 1_700_000_000 - (11 - index) * 300,
            status: 'up',
          })),
        );
      },
    },
    {
      match: 'from public_snapshots',
      first: (args) =>
        args[0] === 'homepage:artifact' && homepageArtifactGeneratedAt > 0
          ? {
              generated_at: homepageArtifactGeneratedAt,
              body_json: '{"generated_at":0}',
            }
          : null,
    },
    {
      match: 'insert into check_results',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'insert into monitor_state',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'into outages',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'update outages',
      run: () => ({ meta: { changes: 1 } }),
    },
    {
      match: 'insert into public_snapshots',
      run: (args) => {
        if (args[0] === 'homepage:artifact') {
          homepageArtifactGeneratedAt = Number(args[1]);
        }
        return { meta: { changes: 1 } };
      },
    },
  ];

  const db = createFakeD1Database(handlers);
  const originalBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    sampleState.batchCalls += 1;
    sampleState.statementCount += statements.length;
    return originalBatch(statements);
  };

  return {
    env: {
      DB: db,
      UPTIMER_PROFILE: scenario.profile,
      UPTIMER_SCHEDULED_REFRESH_LOGS: '0',
    } as unknown as Env,
    sampleState,
  };
}

async function runOne(scenario: Scenario): Promise<Sample> {
  const { env, sampleState } = createEnvForScenario(scenario);
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      sampleState.waitUntilCalls += 1;
      waitUntilPromises.push(promise.catch(() => undefined));
    },
  } as unknown as ExecutionContext;

  const started = performance.now();
  await runScheduledTick(env, ctx);
  await Promise.all(waitUntilPromises);
  const elapsedMs = performance.now() - started;

  return {
    elapsedMs,
    ...sampleState,
  };
}

async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function percentile(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarize(samples: Sample[]) {
  const elapsed = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const batchCalls = samples.map((sample) => sample.batchCalls);
  const statementCounts = samples.map((sample) => sample.statementCount);
  const waitUntilCalls = samples.map((sample) => sample.waitUntilCalls);
  const totalElapsed = elapsed.reduce((sum, value) => sum + value, 0);

  return {
    runs: samples.length,
    meanMs: totalElapsed / samples.length,
    medianMs: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    minMs: elapsed[0] ?? 0,
    maxMs: elapsed.at(-1) ?? 0,
    batchCallsAvg: batchCalls.reduce((sum, value) => sum + value, 0) / batchCalls.length,
    statementCountAvg:
      statementCounts.reduce((sum, value) => sum + value, 0) / statementCounts.length,
    waitUntilCallsAvg:
      waitUntilCalls.reduce((sum, value) => sum + value, 0) / waitUntilCalls.length,
  };
}

async function benchmarkScenario(scenario: Scenario) {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    await runOne(scenario);
  }

  const samples: Sample[] = [];
  for (let index = 0; index < MEASURE_RUNS; index += 1) {
    samples.push(await runOne(scenario));
  }

  return {
    label: BENCH_LABEL,
    scenario: scenario.name,
    monitorCount: scenario.monitorCount,
    dueCount: scenario.dueCount,
    schedule: scenario.schedule,
    profile: scenario.profile,
    withChannel: scenario.withChannel,
    ...summarize(samples),
  };
}

describe('scheduler benchmark', () => {
  it('measures local scheduled tick throughput', async () => {
    const rows: Array<Record<string, unknown>> = [];

    await withMutedConsole(async () => {
      for (const scenario of SCENARIOS) {
        rows.push(await benchmarkScenario(scenario));
      }
    });

    const payload = JSON.stringify(rows, null, 2);
    if (OUTPUT_PATH) {
      await writeFile(OUTPUT_PATH, payload, 'utf8');
    } else {
      console.log(payload);
    }

    expect(rows).toHaveLength(SCENARIOS.length);
    expect(rows.every((row) => Number(row.monitorCount) >= Number(row.dueCount))).toBe(true);
  }, 120_000);
});
