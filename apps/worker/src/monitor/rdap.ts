type RdapBootstrap = {
  services?: Array<[string[], string[]]>;
};

type RdapEvent = {
  eventAction?: unknown;
  eventDate?: unknown;
};

type RdapDomainResponse = {
  events?: RdapEvent[];
};

let bootstrapCache: { value: RdapBootstrap; fetchedAt: number } | null = null;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const signal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  return await fetch(url, {
    headers: { Accept: 'application/rdap+json, application/json' },
    ...(signal ? { signal } : {}),
  });
}

async function getBootstrap(timeoutMs: number): Promise<RdapBootstrap> {
  if (bootstrapCache && Date.now() - bootstrapCache.fetchedAt < BOOTSTRAP_TTL_MS) {
    return bootstrapCache.value;
  }

  const response = await fetchWithTimeout('https://data.iana.org/rdap/dns.json', timeoutMs);
  if (!response.ok) {
    throw new Error(`IANA RDAP bootstrap HTTP ${response.status}`);
  }
  const value = (await response.json()) as RdapBootstrap;
  bootstrapCache = { value, fetchedAt: Date.now() };
  return value;
}

function findRdapBase(bootstrap: RdapBootstrap, domain: string): string | null {
  const tld = domain.split('.').pop()?.toLowerCase();
  if (!tld) return null;

  for (const service of bootstrap.services ?? []) {
    const tlds = service[0] ?? [];
    const urls = service[1] ?? [];
    if (!tlds.some((value) => value.toLowerCase() === tld)) continue;
    const base = urls.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
    if (base) return base.endsWith('/') ? base : `${base}/`;
  }
  return null;
}

export type DomainExpiryResult = {
  expiresAt: number | null;
  rdapBase: string | null;
  error: string | null;
};

export async function checkDomainExpiry(
  domainName: string,
  timeoutMs = 10_000,
): Promise<DomainExpiryResult> {
  const domain = domainName.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || !domain.includes('.')) {
    return { expiresAt: null, rdapBase: null, error: 'Invalid domain name' };
  }

  try {
    const bootstrap = await getBootstrap(timeoutMs);
    const rdapBase = findRdapBase(bootstrap, domain);
    if (!rdapBase) {
      return { expiresAt: null, rdapBase: null, error: 'No RDAP service found for TLD' };
    }

    const response = await fetchWithTimeout(
      `${rdapBase}domain/${encodeURIComponent(domain)}`,
      timeoutMs,
    );
    if (!response.ok) {
      return {
        expiresAt: null,
        rdapBase,
        error: `RDAP HTTP ${response.status}`,
      };
    }

    const body = (await response.json()) as RdapDomainResponse;
    const expiration = (body.events ?? []).find(
      (event) => String(event.eventAction ?? '').toLowerCase() === 'expiration',
    );
    const expiresMs =
      typeof expiration?.eventDate === 'string' ? Date.parse(expiration.eventDate) : Number.NaN;

    return {
      expiresAt: Number.isFinite(expiresMs) ? Math.floor(expiresMs / 1000) : null,
      rdapBase,
      error: Number.isFinite(expiresMs) ? null : 'RDAP response has no expiration event',
    };
  } catch (err) {
    return {
      expiresAt: null,
      rdapBase: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
