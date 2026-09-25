import { writeFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi.fn(),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));
vi.mock('../src/monitor/globalping', () => ({
  runGlobalpingHttpCheck: vi.fn(async () => ({
    status: 'up',
    latencyMs: 42,
    httpStatus: 200,
    error: null,
    attempts: 1,
    location: 'globalping',
    regionResults: [
      {
        location: 'Tokyo, JP',
        status: 'up',
        latencyMs: 42,
        httpStatus: 200,
        error: null,
      },
    ],
  })),
}));

import type { Env } from '../src/env';
import { runPersistedMonitorBatch, runScheduledTick } from '../src/scheduler/scheduled';
import {
  createFakeD1Database,
  type FakeD1ExecutionObserver,
  type FakeD1QueryHandler,
} from './helpers/fake-d1';

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
  d1Reads: number;
  d1Writes: number;
  lockWrites: number;
  checkResultWrites: number;
  stateWrites: number;
  snapshotWrites: number;
  globalpingLatestWrites: number;
  globalpingHistoryWrites: number;
  serviceCalls: number;
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
    interval_sec: 300,
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
    d1Reads: 0,
    d1Writes: 0,
    lockWrites: 0,
    checkResultWrites: 0,
    stateWrites: 0,
    snapshotWrites: 0,
    globalpingLatestWrites: 0,
    globalpingHistoryWrites: 0,
    serviceCalls: 0,
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

  const observer: FakeD1ExecutionObserver = {
    onExecute(method, normalizedSql) {
      const isWrite = method === 'run';
      if (isWrite) {
        sampleState.d1Writes += 1;
        if (
          normalizedSql.includes('into locks') ||
          normalizedSql.includes('delete from locks') ||
          normalizedSql.includes('update locks')
        ) {
          sampleState.lockWrites += 1;
        }
        if (normalizedSql.includes('insert into check_results')) {
          sampleState.checkResultWrites += 1;
        }
        if (normalizedSql.includes('insert into monitor_state')) {
          sampleState.stateWrites += 1;
        }
        if (
          normalizedSql.includes('insert into public_snapshots') ||
          normalizedSql.includes('insert into public_snapshot_fragments')
        ) {
          sampleState.snapshotWrites += 1;
        }
        if (
          normalizedSql.includes('update monitor_extensions') &&
          normalizedSql.includes('globalping_last_results_json')
        ) {
          sampleState.globalpingLatestWrites += 1;
        }
        if (normalizedSql.includes('insert into globalping_history')) {
          sampleState.globalpingHistoryWrites += 1;
        }
      } else {
        sampleState.d1Reads += 1;
      }
    },
  };
  const db = createFakeD1Database(handlers, observer);
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

async function runGlobalpingHistoryOne(): Promise<Sample> {
  const sampleState: Omit<Sample, 'elapsedMs'> = {
    batchCalls: 0,
    statementCount: 0,
    waitUntilCalls: 0,
    d1Reads: 0,
    d1Writes: 0,
    lockWrites: 0,
    checkResultWrites: 0,
    stateWrites: 0,
    snapshotWrites: 0,
    globalpingLatestWrites: 0,
    globalpingHistoryWrites: 0,
    serviceCalls: 0,
  };
  const persistence = {
    previousResultsJson: null as string | null,
    lastHistoryWrittenAt: null as number | null,
  };

  const handlers: FakeD1QueryHandler[] = [
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
      run: () => ({ meta: { changes: 0 } }),
    },
    {
      match: 'update outages',
      run: () => ({ meta: { changes: 0 } }),
    },
    {
      match: (sql) =>
        sql.includes('update monitor_extensions') &&
        sql.includes('globalping_last_results_json'),
      run: (args) => {
        persistence.previousResultsJson =
          typeof args[0] === 'string' ? args[0] : persistence.previousResultsJson;
        return { meta: { changes: 1 } };
      },
    },
    {
      match: 'insert into globalping_history',
      run: (args) => {
        persistence.lastHistoryWrittenAt = Number(args[1]);
        return { meta: { changes: 1 } };
      },
    },
  ];

  const observer: FakeD1ExecutionObserver = {
    onExecute(method, normalizedSql) {
      if (method !== 'run') {
        sampleState.d1Reads += 1;
        return;
      }

      sampleState.d1Writes += 1;
      if (normalizedSql.includes('insert into check_results')) {
        sampleState.checkResultWrites += 1;
      }
      if (normalizedSql.includes('insert into monitor_state')) {
        sampleState.stateWrites += 1;
      }
      if (
        normalizedSql.includes('update monitor_extensions') &&
        normalizedSql.includes('globalping_last_results_json')
      ) {
        sampleState.globalpingLatestWrites += 1;
      }
      if (normalizedSql.includes('insert into globalping_history')) {
        sampleState.globalpingHistoryWrites += 1;
      }
    },
  };

  const db = createFakeD1Database(handlers, observer);
  const originalBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    sampleState.batchCalls += 1;
    sampleState.statementCount += statements.length;
    return originalBatch(statements);
  };

  const baseCheckedAt = 1_700_000_000;
  const started = performance.now();

  // Twelve five-minute checks model one steady hour. P2.1 writes one history
  // row per check; P2.2 should keep all twelve latest-result writes while
  // retaining only the 0/15/30/45-minute history samples.
  for (let index = 0; index < 12; index += 1) {
    const checkedAt = baseCheckedAt + index * 300;
    await runPersistedMonitorBatch({
      db,
      rows: [
        {
          id: 1,
          name: 'Globalping benchmark',
          type: 'http',
          target: 'https://example.com/health',
          display_url: null,
          interval_sec: 300,
          created_at: baseCheckedAt - 86_400,
          timeout_ms: 10_000,
          http_method: 'GET',
          http_headers_json: null,
          http_body: null,
          follow_redirects: 1,
          expected_status_json: null,
          forbidden_status_json: null,
          response_keyword: null,
          response_keyword_mode: null,
          response_forbidden_keyword: null,
          response_forbidden_keyword_mode: null,
          probe_mode: 'globalping',
          globalping_locations_json: JSON.stringify(['Tokyo']),
          globalping_last_results_json: persistence.previousResultsJson,
          globalping_history_last_written_at: persistence.lastHistoryWrittenAt,
          state_status: 'up',
          state_last_error: null,
          last_checked_at: checkedAt - 300,
          last_changed_at: baseCheckedAt - 3600,
          consecutive_failures: 0,
          consecutive_successes: 3,
        } as never,
      ],
      checkedAt,
      stateMachineConfig: {
        failuresToDownFromUp: 2,
        successesToUpFromDown: 2,
      },
    });
  }

  return {
    elapsedMs: performance.now() - started,
    ...sampleState,
  };
}

async function benchmarkGlobalpingHistoryScenario() {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    await runGlobalpingHistoryOne();
  }

  const samples: Sample[] = [];
  for (let index = 0; index < MEASURE_RUNS; index += 1) {
    samples.push(await runGlobalpingHistoryOne());
  }

  return {
    label: BENCH_LABEL,
    scenario: 'low-write / 1 Globalping monitor / 60m steady (12 checks)',
    monitorCount: 1,
    dueCount: 1,
    schedule: 'staggered' as const,
    profile: 'low-write' as const,
    withChannel: false,
    ...summarize(samples),
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
  const d1Reads = samples.map((sample) => sample.d1Reads);
  const d1Writes = samples.map((sample) => sample.d1Writes);
  const lockWrites = samples.map((sample) => sample.lockWrites);
  const checkResultWrites = samples.map((sample) => sample.checkResultWrites);
  const stateWrites = samples.map((sample) => sample.stateWrites);
  const snapshotWrites = samples.map((sample) => sample.snapshotWrites);
  const globalpingLatestWrites = samples.map((sample) => sample.globalpingLatestWrites);
  const globalpingHistoryWrites = samples.map((sample) => sample.globalpingHistoryWrites);
  const serviceCalls = samples.map((sample) => sample.serviceCalls);
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
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
    waitUntilCallsAvg: average(waitUntilCalls),
    d1ReadsAvg: average(d1Reads),
    d1WritesAvg: average(d1Writes),
    lockWritesAvg: average(lockWrites),
    checkResultWritesAvg: average(checkResultWrites),
    stateWritesAvg: average(stateWrites),
    snapshotWritesAvg: average(snapshotWrites),
    globalpingLatestWritesAvg: average(globalpingLatestWrites),
    globalpingHistoryWritesAvg: average(globalpingHistoryWrites),
    serviceCallsAvg: average(serviceCalls),
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
      rows.push(await benchmarkGlobalpingHistoryScenario());
    });

    const payload = JSON.stringify(rows, null, 2);
    if (OUTPUT_PATH) {
      await writeFile(OUTPUT_PATH, payload, 'utf8');
    } else {
      console.log(payload);
    }

    expect(rows).toHaveLength(SCENARIOS.length + 1);
    expect(rows.every((row) => Number(row.monitorCount) >= Number(row.dueCount))).toBe(true);
  }, 120_000);
});
