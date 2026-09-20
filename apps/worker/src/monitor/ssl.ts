import { connect, type PeerCertificate } from 'node:tls';

export type SslCheckResult = {
  expiresAt: number | null;
  authorized: boolean;
  subject: string | null;
  issuer: string | null;
  error: string | null;
};

function dnToString(value: PeerCertificate['subject']): string | null {
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value)
    .filter(([, item]) => typeof item === 'string' && item.length > 0)
    .map(([key, item]) => `${key}=${String(item)}`);
  return entries.length > 0 ? entries.join(', ') : null;
}

export async function checkSslCertificate(
  hostname: string,
  port = 443,
  timeoutMs = 10_000,
): Promise<SslCheckResult> {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return { expiresAt: null, authorized: false, subject: null, issuer: null, error: 'Missing host' };
  }

  return await new Promise<SslCheckResult>((resolve) => {
    let settled = false;
    const finish = (result: SslCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const socket = connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
    });

    const timer = setTimeout(() => {
      finish({
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: `TLS timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate();
        const expiresMs = Date.parse(cert.valid_to ?? '');
        finish({
          expiresAt: Number.isFinite(expiresMs) ? Math.floor(expiresMs / 1000) : null,
          authorized: socket.authorized,
          subject: dnToString(cert.subject),
          issuer: dnToString(cert.issuer),
          error: socket.authorized
            ? null
            : typeof socket.authorizationError === 'string'
              ? socket.authorizationError
              : socket.authorizationError instanceof Error
                ? socket.authorizationError.message
                : 'TLS certificate rejected',
        });
      } catch (err) {
        finish({
          expiresAt: null,
          authorized: false,
          subject: null,
          issuer: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    socket.once('error', (err) => {
      finish({
        expiresAt: null,
        authorized: false,
        subject: null,
        issuer: null,
        error: err.message,
      });
    });
  });
}
