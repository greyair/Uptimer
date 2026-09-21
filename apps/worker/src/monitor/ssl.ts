export type SslCheckResult = {
  expiresAt: number | null;
  authorized: boolean;
  subject: string | null;
  issuer: string | null;
  error: string | null;
};

type GlobalpingTlsInfo = {
  authorized?: unknown;
  error?: unknown;
  expiresAt?: unknown;
  subject?: Record<string, unknown> | null;
  issuer?: Record<string, unknown> | null;
};

type GlobalpingMeasurement = {
  id?: unknown;
  status?: unknown;
  results?: Array<{
    result?: {
      status?: unknown;
      tls?: GlobalpingTlsInfo | null;
      rawOutput?: unknown;
    };
  }>;
};

const GLOBALPING_API_BASE = 'https://api.globalping.io/v1';

function objectToDn(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const parts = Object.entries(value)
    .filter(([, item]) => typeof item === 'string' && item.trim().length > 0)
    .map(([key, item]) => `${key}=${String(item).trim()}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; json: unknown }> {
  const signal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  const text = await response.text();
  if (!text.trim()) return { response, json: null };
  try {
    return { response, json: JSON.parse(text) as unknown };
  } catch {
    return { response, json: null };
  }
}

export async function checkSslCertificate(
  hostname: string,
  port = 443,
  timeoutMs = 10_000,
  apiToken?: string | null,
): Promise<SslCheckResult> {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return {
      expiresAt: null,
      authorized: false,
      subject: null,
      issuer: null,
      error: 'Missing host',
    };
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (apiToken?.trim()) {
    headers.set('Authorization', `Bearer ${apiToken.trim()}`);
  }

  try {
    const create = await fetchJson(
      `${GLOBALPING_API_BASE}/measurements`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'http',
          target: host,
          timeout: Math.max(5, Math.min(30, Math.ceil(timeoutMs / 1000))),
          measurementOptions: {
            protocol: 'HTTPS',
            port,
            request: {
              path: '/',
              method: 'HEAD',
            },
          },
        }),
      },
      Math.max(timeoutMs, 15_000),
    );

    if (create.response.status !== 202) {
      return {
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: `Globalping TLS probe HTTP ${create.response.status}`,
      };
    }

    const created = (create.json ?? {}) as GlobalpingMeasurement;
    const measurementId =
      typeof created.id === 'string'
        ? created.id
        : create.response.headers.get('Location')?.split('/').filter(Boolean).pop() ?? null;

    if (!measurementId) {
      return {
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: 'Globalping TLS probe did not return a measurement id',
      };
    }

    const authHeaders = apiToken?.trim()
      ? { Authorization: `Bearer ${apiToken.trim()}` }
      : undefined;
    let measurement: GlobalpingMeasurement | null = null;
    const deadline = Date.now() + Math.max(timeoutMs, 15_000);

    while (Date.now() < deadline) {
      const fetched = await fetchJson(
        `${GLOBALPING_API_BASE}/measurements/${encodeURIComponent(measurementId)}`,
        authHeaders ? { headers: authHeaders } : {},
        Math.max(5_000, Math.min(timeoutMs, 15_000)),
      );

      if (!fetched.response.ok) {
        return {
          expiresAt: null,
          authorized: false,
          subject: null,
          issuer: null,
          error: `Globalping TLS measurement HTTP ${fetched.response.status}`,
        };
      }

      measurement = (fetched.json ?? {}) as GlobalpingMeasurement;
      if (measurement.status !== 'in-progress') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!measurement || measurement.status === 'in-progress') {
      return {
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: 'Globalping TLS measurement timed out',
      };
    }

    const first = measurement.results?.[0]?.result;
    const tls = first?.tls ?? null;
    if (!tls) {
      const rawOutput = typeof first?.rawOutput === 'string' ? first.rawOutput.trim() : '';
      return {
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: rawOutput || 'Globalping TLS result did not include certificate metadata',
      };
    }

    const expiresMs =
      typeof tls.expiresAt === 'string' ? Date.parse(tls.expiresAt) : Number.NaN;
    const authorized = tls.authorized === true;
    const tlsError = typeof tls.error === 'string' ? tls.error.trim() : '';

    return {
      expiresAt: Number.isFinite(expiresMs) ? Math.floor(expiresMs / 1000) : null,
      authorized,
      subject: objectToDn(tls.subject),
      issuer: objectToDn(tls.issuer),
      error: authorized ? null : tlsError || 'TLS certificate rejected',
    };
  } catch (err) {
    return {
      expiresAt: null,
      authorized: false,
      subject: null,
      issuer: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
