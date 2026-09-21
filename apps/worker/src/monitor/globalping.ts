import { evaluateHttpStatusCode, type StatusCodeRule } from '@uptimer/db';

import type { HttpResponseMatchMode } from './http-assertions';
import type { CheckOutcome } from './types';

export type GlobalpingHttpCheckConfig = {
  url: string;
  timeoutMs: number;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers: Record<string, string> | null;
  body: string | null;
  expectedStatus: StatusCodeRule[] | null;
  forbiddenStatus: StatusCodeRule[] | null;
  responseKeyword: string | null;
  responseKeywordMode: HttpResponseMatchMode | null;
  responseForbiddenKeyword: string | null;
  responseForbiddenKeywordMode: HttpResponseMatchMode | null;
  locations: string[];
  apiToken?: string | null;
};

export type GlobalpingRegionResult = {
  location: string;
  status: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

type MeasurementResult = {
  probe?: {
    city?: unknown;
    country?: unknown;
    continent?: unknown;
    network?: unknown;
  };
  result?: {
    status?: unknown;
    statusCode?: unknown;
    rawBody?: unknown;
    timings?: { total?: unknown };
    rawOutput?: unknown;
  };
};

type MeasurementResponse = {
  id?: unknown;
  status?: unknown;
  results?: MeasurementResult[];
};

const API_BASE = 'https://api.globalping.io/v1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function regionLabel(result: MeasurementResult, fallback: string): string {
  const probe = result.probe;
  const city = typeof probe?.city === 'string' ? probe.city : '';
  const country = typeof probe?.country === 'string' ? probe.country : '';
  const continent = typeof probe?.continent === 'string' ? probe.continent : '';
  const network = typeof probe?.network === 'string' ? probe.network : '';
  const parts = [city, country, continent].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : network || fallback;
}

function evaluateBodyAssertions(
  body: string | null,
  config: GlobalpingHttpCheckConfig,
): string | null {
  if (config.responseKeyword) {
    if (config.responseKeywordMode === 'regex') {
      try {
        if (!new RegExp(config.responseKeyword).test(body ?? '')) {
          return 'Required response regex did not match';
        }
      } catch (err) {
        return `Invalid response regex: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!(body ?? '').includes(config.responseKeyword)) {
      return 'Required response keyword not found';
    }
  }

  if (config.responseForbiddenKeyword) {
    if (config.responseForbiddenKeywordMode === 'regex') {
      try {
        if (new RegExp(config.responseForbiddenKeyword).test(body ?? '')) {
          return 'Forbidden response regex matched';
        }
      } catch (err) {
        return `Invalid forbidden response regex: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if ((body ?? '').includes(config.responseForbiddenKeyword)) {
      return 'Forbidden response keyword found';
    }
  }

  return null;
}

function evaluateResult(
  item: MeasurementResult,
  fallbackLocation: string,
  config: GlobalpingHttpCheckConfig,
): GlobalpingRegionResult {
  const result = item.result;
  const label = regionLabel(item, fallbackLocation);
  if (!result || result.status !== 'finished') {
    const rawOutput = typeof result?.rawOutput === 'string' ? result.rawOutput.trim() : '';
    return {
      location: label,
      status: result?.status === 'failed' ? 'down' : 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: rawOutput || `Globalping result status: ${String(result?.status ?? 'missing')}`,
    };
  }

  const httpStatus = typeof result.statusCode === 'number' ? result.statusCode : null;
  const latencyMs =
    typeof result.timings?.total === 'number' && Number.isFinite(result.timings.total)
      ? Math.round(result.timings.total)
      : null;

  if (httpStatus === null) {
    return {
      location: label,
      status: 'unknown',
      latencyMs,
      httpStatus: null,
      error: 'Globalping HTTP result has no status code',
    };
  }

  const statusEval = evaluateHttpStatusCode(httpStatus, {
    expected: config.expectedStatus,
    forbidden: config.forbiddenStatus,
  });
  if (!statusEval.ok) {
    return {
      location: label,
      status: 'down',
      latencyMs,
      httpStatus,
      error:
        statusEval.reason === 'forbidden'
          ? `Forbidden HTTP status: ${httpStatus}`
          : `Unexpected HTTP status: ${httpStatus}`,
    };
  }

  const body = typeof result.rawBody === 'string' ? result.rawBody : null;
  const assertionError = evaluateBodyAssertions(body, config);
  if (assertionError) {
    return { location: label, status: 'down', latencyMs, httpStatus, error: assertionError };
  }

  return { location: label, status: 'up', latencyMs, httpStatus, error: null };
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
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { response, json };
}

export async function runGlobalpingHttpCheck(
  config: GlobalpingHttpCheckConfig,
): Promise<CheckOutcome & { regionResults: GlobalpingRegionResult[] }> {
  const started = performance.now();
  const locations = config.locations.map((item) => item.trim()).filter(Boolean).slice(0, 10);
  if (locations.length === 0) {
    return {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: 'Globalping requires at least one location',
      attempts: 1,
      location: 'globalping',
      regionResults: [],
    };
  }

  if (config.body !== null && config.body.length > 0) {
    return {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: 'Globalping HTTP probe does not currently support request bodies',
      attempts: 1,
      location: 'globalping',
      regionResults: [],
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    return {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: 'Invalid HTTP URL',
      attempts: 1,
      location: 'globalping',
      regionResults: [],
    };
  }

  const protocol =
    parsedUrl.protocol === 'https:' ? 'HTTPS' : parsedUrl.protocol === 'http:' ? 'HTTP' : null;
  if (!protocol) {
    return {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: 'Globalping only supports http/https targets',
      attempts: 1,
      location: 'globalping',
      regionResults: [],
    };
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (config.apiToken?.trim()) {
    headers.set('Authorization', `Bearer ${config.apiToken.trim()}`);
  }

  const requestHeaders = { ...(config.headers ?? {}) };
  delete requestHeaders.Host;
  delete requestHeaders.host;
  delete requestHeaders['User-Agent'];
  delete requestHeaders['user-agent'];

  const createBody = {
    type: 'http',
    target: parsedUrl.hostname,
    locations: locations.map((magic) => ({ magic, limit: 1 })),
    timeout: Math.max(5, Math.min(30, Math.ceil(config.timeoutMs / 1000))),
    measurementOptions: {
      protocol,
      port: parsedUrl.port
        ? Number(parsedUrl.port)
        : protocol === 'HTTPS'
          ? 443
          : 80,
      request: {
        path: parsedUrl.pathname || '/',
        ...(parsedUrl.search.length > 1 ? { query: parsedUrl.search.slice(1) } : {}),
        method: config.method,
        ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
      },
    },
  };

  try {
    const create = await fetchJson(
      `${API_BASE}/measurements`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(createBody),
      },
      Math.max(config.timeoutMs, 15_000),
    );

    if (create.response.status !== 202) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        httpStatus: create.response.status,
        error: `Globalping create measurement HTTP ${create.response.status}`,
        attempts: 1,
        location: 'globalping',
        regionResults: [],
      };
    }

    const created = (create.json ?? {}) as MeasurementResponse;
    const measurementId =
      typeof created.id === 'string'
        ? created.id
        : create.response.headers.get('Location')?.split('/').filter(Boolean).pop() ?? null;
    if (!measurementId) {
      return {
        status: 'unknown',
        latencyMs: Math.round(performance.now() - started),
        httpStatus: null,
        error: 'Globalping did not return a measurement id',
        attempts: 1,
        location: 'globalping',
        regionResults: [],
      };
    }

    let measurement: MeasurementResponse | null = null;
    const deadline = Date.now() + Math.max(config.timeoutMs, 15_000);
    while (Date.now() < deadline) {
      const fetched = await fetchJson(
        `${API_BASE}/measurements/${encodeURIComponent(measurementId)}`,
        { headers: config.apiToken?.trim() ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {} },
        Math.max(5_000, Math.min(config.timeoutMs, 15_000)),
      );
      if (!fetched.response.ok) {
        return {
          status: 'down',
          latencyMs: Math.round(performance.now() - started),
          httpStatus: fetched.response.status,
          error: `Globalping measurement HTTP ${fetched.response.status}`,
          attempts: 1,
          location: 'globalping',
          regionResults: [],
        };
      }
      measurement = (fetched.json ?? {}) as MeasurementResponse;
      if (measurement.status !== 'in-progress') break;
      await sleep(500);
    }

    if (!measurement || measurement.status === 'in-progress') {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        httpStatus: null,
        error: 'Globalping measurement timed out',
        attempts: 1,
        location: 'globalping',
        regionResults: [],
      };
    }

    const regionResults = (measurement.results ?? []).map((item, index) =>
      evaluateResult(item, locations[index] ?? `probe-${index + 1}`, config),
    );
    if (regionResults.length === 0) {
      return {
        status: 'unknown',
        latencyMs: Math.round(performance.now() - started),
        httpStatus: null,
        error: 'Globalping returned no probe results',
        attempts: 1,
        location: 'globalping',
        regionResults,
      };
    }

    const failed = regionResults.filter((item) => item.status !== 'up');
    const usableLatencies = regionResults
      .map((item) => item.latencyMs)
      .filter((value): value is number => value !== null);
    const latencyMs =
      usableLatencies.length > 0
        ? Math.round(usableLatencies.reduce((sum, value) => sum + value, 0) / usableLatencies.length)
        : Math.round(performance.now() - started);
    const representativeStatus = regionResults.find((item) => item.httpStatus !== null)?.httpStatus ?? null;

    if (failed.length > 0) {
      const details = failed
        .map((item) => `${item.location}: ${item.error ?? item.status}`)
        .slice(0, 4)
        .join('; ');
      return {
        status: failed.some((item) => item.status === 'down') ? 'down' : 'unknown',
        latencyMs,
        httpStatus: representativeStatus,
        error: `${failed.length}/${regionResults.length} Globalping probes failed: ${details}`,
        attempts: 1,
        location: 'globalping',
        regionResults,
      };
    }

    return {
      status: 'up',
      latencyMs,
      httpStatus: representativeStatus,
      error: null,
      attempts: 1,
      location: 'globalping',
      regionResults,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      attempts: 1,
      location: 'globalping',
      regionResults: [],
    };
  }
}
