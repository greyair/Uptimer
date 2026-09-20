export type ProbeMode = 'direct' | 'globalping';

export type MonitorExtensionConfig = {
  monitorId: number;
  probeMode: ProbeMode;
  globalpingLocations: string[];
  sslCheckEnabled: boolean;
  sslWarnDays: number;
  sslLastCheckedAt: number | null;
  sslExpiresAt: number | null;
  sslError: string | null;
  domainName: string | null;
  domainWarnDays: number;
  domainLastCheckedAt: number | null;
  domainExpiresAt: number | null;
  domainError: string | null;
};

export type MonitorExtensionInput = {
  probeMode?: ProbeMode;
  globalpingLocations?: string[];
  sslCheckEnabled?: boolean;
  sslWarnDays?: number;
  domainName?: string | null;
  domainWarnDays?: number;
};

const DEFAULT_EXTENSION = {
  probeMode: 'direct' as const,
  globalpingLocations: [] as string[],
  sslCheckEnabled: false,
  sslWarnDays: 30,
  domainName: null as string | null,
  domainWarnDays: 30,
};

function parseLocations(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function normalizeDomainName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function defaultMonitorExtension(monitorId: number): MonitorExtensionConfig {
  return {
    monitorId,
    ...DEFAULT_EXTENSION,
    sslLastCheckedAt: null,
    sslExpiresAt: null,
    sslError: null,
    domainLastCheckedAt: null,
    domainExpiresAt: null,
    domainError: null,
  };
}

export async function getMonitorExtension(
  db: D1Database,
  monitorId: number,
): Promise<MonitorExtensionConfig> {
  const row = await db
    .prepare(
      `SELECT
        monitor_id,
        probe_mode,
        globalping_locations_json,
        ssl_check_enabled,
        ssl_warn_days,
        ssl_last_checked_at,
        ssl_expires_at,
        ssl_error,
        domain_name,
        domain_warn_days,
        domain_last_checked_at,
        domain_expires_at,
        domain_error
      FROM monitor_extensions
      WHERE monitor_id = ?1`,
    )
    .bind(monitorId)
    .first<{
      monitor_id: number;
      probe_mode: string;
      globalping_locations_json: string | null;
      ssl_check_enabled: number | boolean;
      ssl_warn_days: number;
      ssl_last_checked_at: number | null;
      ssl_expires_at: number | null;
      ssl_error: string | null;
      domain_name: string | null;
      domain_warn_days: number;
      domain_last_checked_at: number | null;
      domain_expires_at: number | null;
      domain_error: string | null;
    }>();

  if (!row) return defaultMonitorExtension(monitorId);

  return {
    monitorId,
    probeMode: row.probe_mode === 'globalping' ? 'globalping' : 'direct',
    globalpingLocations: parseLocations(row.globalping_locations_json),
    sslCheckEnabled: row.ssl_check_enabled === true || row.ssl_check_enabled === 1,
    sslWarnDays: row.ssl_warn_days,
    sslLastCheckedAt: row.ssl_last_checked_at,
    sslExpiresAt: row.ssl_expires_at,
    sslError: row.ssl_error,
    domainName: row.domain_name,
    domainWarnDays: row.domain_warn_days,
    domainLastCheckedAt: row.domain_last_checked_at,
    domainExpiresAt: row.domain_expires_at,
    domainError: row.domain_error,
  };
}

export async function listMonitorExtensions(
  db: D1Database,
  monitorIds: readonly number[],
): Promise<Map<number, MonitorExtensionConfig>> {
  const ids = [...new Set(monitorIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, MonitorExtensionConfig>();
  for (const id of ids) out.set(id, defaultMonitorExtension(id));
  if (ids.length === 0) return out;

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT
        monitor_id,
        probe_mode,
        globalping_locations_json,
        ssl_check_enabled,
        ssl_warn_days,
        ssl_last_checked_at,
        ssl_expires_at,
        ssl_error,
        domain_name,
        domain_warn_days,
        domain_last_checked_at,
        domain_expires_at,
        domain_error
      FROM monitor_extensions
      WHERE monitor_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<Record<string, unknown>>();

  for (const raw of results ?? []) {
    const id = Number(raw.monitor_id);
    if (!Number.isInteger(id)) continue;
    out.set(id, {
      monitorId: id,
      probeMode: raw.probe_mode === 'globalping' ? 'globalping' : 'direct',
      globalpingLocations: parseLocations(
        typeof raw.globalping_locations_json === 'string'
          ? raw.globalping_locations_json
          : null,
      ),
      sslCheckEnabled: raw.ssl_check_enabled === true || raw.ssl_check_enabled === 1,
      sslWarnDays:
        typeof raw.ssl_warn_days === 'number' ? raw.ssl_warn_days : DEFAULT_EXTENSION.sslWarnDays,
      sslLastCheckedAt:
        typeof raw.ssl_last_checked_at === 'number' ? raw.ssl_last_checked_at : null,
      sslExpiresAt: typeof raw.ssl_expires_at === 'number' ? raw.ssl_expires_at : null,
      sslError: typeof raw.ssl_error === 'string' ? raw.ssl_error : null,
      domainName: typeof raw.domain_name === 'string' ? raw.domain_name : null,
      domainWarnDays:
        typeof raw.domain_warn_days === 'number'
          ? raw.domain_warn_days
          : DEFAULT_EXTENSION.domainWarnDays,
      domainLastCheckedAt:
        typeof raw.domain_last_checked_at === 'number' ? raw.domain_last_checked_at : null,
      domainExpiresAt: typeof raw.domain_expires_at === 'number' ? raw.domain_expires_at : null,
      domainError: typeof raw.domain_error === 'string' ? raw.domain_error : null,
    });
  }

  return out;
}

export async function upsertMonitorExtension(
  db: D1Database,
  monitorId: number,
  input: MonitorExtensionInput,
  now: number,
): Promise<MonitorExtensionConfig> {
  const existing = await getMonitorExtension(db, monitorId);
  const probeMode = input.probeMode ?? existing.probeMode;
  const globalpingLocations = (input.globalpingLocations ?? existing.globalpingLocations)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
  const sslCheckEnabled = input.sslCheckEnabled ?? existing.sslCheckEnabled;
  const sslWarnDays = input.sslWarnDays ?? existing.sslWarnDays;
  const domainName =
    input.domainName !== undefined ? normalizeDomainName(input.domainName) : existing.domainName;
  const domainWarnDays = input.domainWarnDays ?? existing.domainWarnDays;

  await db
    .prepare(
      `INSERT INTO monitor_extensions (
        monitor_id,
        probe_mode,
        globalping_locations_json,
        ssl_check_enabled,
        ssl_warn_days,
        domain_name,
        domain_warn_days,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(monitor_id) DO UPDATE SET
        probe_mode = excluded.probe_mode,
        globalping_locations_json = excluded.globalping_locations_json,
        ssl_check_enabled = excluded.ssl_check_enabled,
        ssl_warn_days = excluded.ssl_warn_days,
        domain_name = excluded.domain_name,
        domain_warn_days = excluded.domain_warn_days,
        updated_at = excluded.updated_at`,
    )
    .bind(
      monitorId,
      probeMode,
      JSON.stringify(globalpingLocations),
      sslCheckEnabled ? 1 : 0,
      sslWarnDays,
      domainName,
      domainWarnDays,
      now,
    )
    .run();

  return await getMonitorExtension(db, monitorId);
}

export async function deleteMonitorExtension(db: D1Database, monitorId: number): Promise<void> {
  await db.prepare('DELETE FROM monitor_extensions WHERE monitor_id = ?1').bind(monitorId).run();
}
