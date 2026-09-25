import type { Env } from '../env';

export type UptimerProfile = 'low-write' | 'balanced' | 'high-scale';

export type ProfileBooleanKey =
  | 'UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES'
  | 'UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH'
  | 'UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED'
  | 'UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED'
  | 'UPTIMER_PUBLIC_SHARDED_ASSEMBLER'
  | 'UPTIMER_SCHEDULED_SHARDED_ASSEMBLER'
  | 'UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH'
  | 'UPTIMER_SCHEDULED_SHARDED_PUBLISH'
  | 'UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES'
  | 'UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED'
  | 'UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH'
  | 'UPTIMER_SCHEDULED_SHARDED_CONTINUATION'
  | 'UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT';

type ProfileDefaults = {
  publicSnapshotFreshnessSeconds: number;
  internalScheduledBatchSize: number;
  flags: Record<ProfileBooleanKey, boolean>;
};

const LOW_WRITE_FLAGS: Record<ProfileBooleanKey, boolean> = {
  UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES: false,
  UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH: false,
  UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: false,
  UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED: false,
  UPTIMER_PUBLIC_SHARDED_ASSEMBLER: false,
  UPTIMER_SCHEDULED_SHARDED_ASSEMBLER: false,
  UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: false,
  UPTIMER_SCHEDULED_SHARDED_PUBLISH: false,
  UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: false,
  UPTIMER_PUBLIC_SHARDED_HOMEPAGE_RUNTIME_SEED: false,
  UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: false,
  UPTIMER_SCHEDULED_SHARDED_CONTINUATION: false,
  UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT: false,
};

const HIGH_SCALE_FLAGS: Record<ProfileBooleanKey, boolean> = {
  ...LOW_WRITE_FLAGS,
  UPTIMER_PUBLIC_MONITOR_UPDATE_FRAGMENT_WRITES: true,
  UPTIMER_SCHEDULED_RUNTIME_FRAGMENT_REFRESH: true,
  UPTIMER_PUBLIC_SHARDED_FRAGMENT_SEED: true,
  UPTIMER_SCHEDULED_SHARDED_FRAGMENT_SEED: true,
  UPTIMER_PUBLIC_SHARDED_ASSEMBLER: true,
  UPTIMER_SCHEDULED_SHARDED_ASSEMBLER: true,
  UPTIMER_PUBLIC_SHARDED_SNAPSHOT_PUBLISH: true,
  UPTIMER_SCHEDULED_SHARDED_PUBLISH: true,
  UPTIMER_PUBLIC_HOMEPAGE_ARTIFACT_FRAGMENT_WRITES: true,
  UPTIMER_SCHEDULED_SHARDED_SKIP_HOMEPAGE_REFRESH: true,
  UPTIMER_SCHEDULED_SHARDED_CONTINUATION: true,
  UPTIMER_INTERNAL_CHECK_BATCH_FRAGMENT_WRITE_SPLIT: true,
};

const PROFILE_DEFAULTS: Record<UptimerProfile, ProfileDefaults> = {
  'low-write': {
    publicSnapshotFreshnessSeconds: 5 * 60,
    internalScheduledBatchSize: 6,
    flags: LOW_WRITE_FLAGS,
  },
  balanced: {
    publicSnapshotFreshnessSeconds: 60,
    internalScheduledBatchSize: 6,
    flags: LOW_WRITE_FLAGS,
  },
  'high-scale': {
    publicSnapshotFreshnessSeconds: 60,
    internalScheduledBatchSize: 2,
    flags: HIGH_SCALE_FLAGS,
  },
};

function readRawEnv(env: Env, key: string): unknown {
  return (env as unknown as Record<string, unknown>)[key];
}

function parseBooleanEnv(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return null;
}

function readBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function readUptimerProfile(env: Env): UptimerProfile {
  const raw = readRawEnv(env, 'UPTIMER_PROFILE');
  if (typeof raw !== 'string') return 'balanced';
  const normalized = raw.trim().toLowerCase();
  return normalized === 'low-write' || normalized === 'balanced' || normalized === 'high-scale'
    ? normalized
    : 'balanced';
}

export function readProfileBoolean(env: Env, key: ProfileBooleanKey): boolean {
  const explicit = parseBooleanEnv(readRawEnv(env, key));
  if (explicit !== null) return explicit;
  return PROFILE_DEFAULTS[readUptimerProfile(env)].flags[key];
}

export function readPublicSnapshotFreshnessSeconds(env: Env): number {
  const fallback = PROFILE_DEFAULTS[readUptimerProfile(env)].publicSnapshotFreshnessSeconds;
  return readBoundedInteger(
    readRawEnv(env, 'UPTIMER_PUBLIC_SNAPSHOT_FRESHNESS_SECONDS'),
    fallback,
    60,
    10 * 60,
  );
}

export function readInternalScheduledBatchSize(env: Env): number {
  const fallback = PROFILE_DEFAULTS[readUptimerProfile(env)].internalScheduledBatchSize;
  return readBoundedInteger(
    readRawEnv(env, 'UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE'),
    fallback,
    1,
    6,
  );
}

export function isLowWriteProfile(env: Env): boolean {
  return readUptimerProfile(env) === 'low-write';
}
