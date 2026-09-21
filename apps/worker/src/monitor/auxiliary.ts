import pLimit from 'p-limit';

import { checkDomainExpiry } from './rdap';
import { checkSslCertificate } from './ssl';

const SSL_REFRESH_SECONDS = 12 * 60 * 60;
const DOMAIN_REFRESH_SECONDS = 24 * 60 * 60;
const AUXILIARY_CONCURRENCY = 3;
const MAX_ROWS_PER_TICK = 12;

type AuxiliaryRow = {
  monitor_id: number;
  name: string;
  target: string;
  display_url: string | null;
  ssl_check_enabled: number | boolean;
  ssl_warn_days: number;
  ssl_last_checked_at: number | null;
  domain_name: string | null;
  domain_warn_days: number;
  domain_last_checked_at: number | null;
};

export type ExpiryAlert = {
  kind: 'ssl' | 'domain';
  monitorId: number;
  monitorName: string;
  target: string;
  displayUrl: string | null;
  subject: string;
  expiresAt: number;
  warnDays: number;
  daysRemaining: number;
};

function isEnabled(value: number | boolean): boolean {
  return value === true || value === 1;
}

async function updateSsl(
  db: D1Database,
  row: AuxiliaryRow,
  now: number,
  globalpingApiToken?: string,
): Promise<ExpiryAlert | null> {
  if (!isEnabled(row.ssl_check_enabled)) return null;
  if (row.ssl_last_checked_at !== null && row.ssl_last_checked_at > now - SSL_REFRESH_SECONDS) return null;

  let url: URL;
  try {
    url = new URL(row.target);
  } catch {
    await db
      .prepare(
        `UPDATE monitor_extensions
         SET ssl_last_checked_at = ?1, ssl_expires_at = NULL,
             ssl_error = ?2, updated_at = ?1
         WHERE monitor_id = ?3`,
      )
      .bind(now, 'Invalid monitor URL', row.monitor_id)
      .run();
    return null;
  }

  if (url.protocol !== 'https:') {
    await db
      .prepare(
        `UPDATE monitor_extensions
         SET ssl_last_checked_at = ?1, ssl_expires_at = NULL,
             ssl_error = ?2, updated_at = ?1
         WHERE monitor_id = ?3`,
      )
      .bind(now, 'SSL certificate checks require an https target', row.monitor_id)
      .run();
    return null;
  }

  const port = url.port ? Number(url.port) : 443;
  const result = await checkSslCertificate(url.hostname, port, 10_000, globalpingApiToken ?? null);
  await db
    .prepare(
      `UPDATE monitor_extensions
       SET ssl_last_checked_at = ?1,
           ssl_expires_at = ?2,
           ssl_error = ?3,
           updated_at = ?1
       WHERE monitor_id = ?4`,
    )
    .bind(now, result.expiresAt, result.error, row.monitor_id)
    .run();

  if (result.expiresAt === null || result.error) return null;
  const daysRemaining = Math.ceil((result.expiresAt - now) / 86_400);
  if (daysRemaining > row.ssl_warn_days) return null;

  return {
    kind: 'ssl',
    monitorId: row.monitor_id,
    monitorName: row.name,
    target: row.target,
    displayUrl: row.display_url,
    subject: url.hostname,
    expiresAt: result.expiresAt,
    warnDays: row.ssl_warn_days,
    daysRemaining,
  };
}

async function updateDomain(
  db: D1Database,
  row: AuxiliaryRow,
  now: number,
): Promise<ExpiryAlert | null> {
  if (!row.domain_name) return null;
  if (
    row.domain_last_checked_at !== null &&
    row.domain_last_checked_at > now - DOMAIN_REFRESH_SECONDS
  ) {
    return null;
  }

  const result = await checkDomainExpiry(row.domain_name);
  await db
    .prepare(
      `UPDATE monitor_extensions
       SET domain_last_checked_at = ?1,
           domain_expires_at = ?2,
           domain_error = ?3,
           updated_at = ?1
       WHERE monitor_id = ?4`,
    )
    .bind(now, result.expiresAt, result.error, row.monitor_id)
    .run();

  if (result.expiresAt === null || result.error) return null;
  const daysRemaining = Math.ceil((result.expiresAt - now) / 86_400);
  if (daysRemaining > row.domain_warn_days) return null;

  return {
    kind: 'domain',
    monitorId: row.monitor_id,
    monitorName: row.name,
    target: row.target,
    displayUrl: row.display_url,
    subject: row.domain_name,
    expiresAt: result.expiresAt,
    warnDays: row.domain_warn_days,
    daysRemaining,
  };
}

export async function runDueAuxiliaryChecks(
  db: D1Database,
  now: number,
  globalpingApiToken?: string,
): Promise<ExpiryAlert[]> {
  const { results } = await db
    .prepare(
      `SELECT
        e.monitor_id,
        m.name,
        m.target,
        m.display_url,
        e.ssl_check_enabled,
        e.ssl_warn_days,
        e.ssl_last_checked_at,
        e.domain_name,
        e.domain_warn_days,
        e.domain_last_checked_at
      FROM monitor_extensions e
      JOIN monitors m ON m.id = e.monitor_id
      WHERE m.is_active = 1
        AND m.type = 'http'
        AND (
          (e.ssl_check_enabled = 1 AND
            (e.ssl_last_checked_at IS NULL OR e.ssl_last_checked_at <= ?1))
          OR
          (e.domain_name IS NOT NULL AND
            (e.domain_last_checked_at IS NULL OR e.domain_last_checked_at <= ?2))
        )
      ORDER BY COALESCE(e.ssl_last_checked_at, 0), COALESCE(e.domain_last_checked_at, 0), e.monitor_id
      LIMIT ?3`,
    )
    .bind(now - SSL_REFRESH_SECONDS, now - DOMAIN_REFRESH_SECONDS, MAX_ROWS_PER_TICK)
    .all<AuxiliaryRow>();

  const limit = pLimit(AUXILIARY_CONCURRENCY);
  const settled = await Promise.all(
    (results ?? []).map((row) =>
      limit(async () =>
        await Promise.all([
          updateSsl(db, row, now, globalpingApiToken),
          updateDomain(db, row, now),
        ]),
      ),
    ),
  );

  return settled.flat().filter((alert): alert is ExpiryAlert => alert !== null);
}
