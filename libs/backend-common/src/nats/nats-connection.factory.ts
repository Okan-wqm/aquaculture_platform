/**
 * SEC-H01: Centralized NATS connection options factory.
 *
 * All services MUST use this factory to build NATS connection options.
 * This ensures consistent authentication, TLS configuration, and
 * reconnection behavior across the entire platform.
 *
 * Environment variables consumed:
 *   NATS_URL          — server address (default: nats://localhost:4222)
 *   NATS_AUTH_USER    — username for NATS authorization block
 *   NATS_AUTH_PASS    — password for NATS authorization block
 *   NATS_AUTH_TOKEN   — token-based auth (alternative to user/pass)
 *
 * Architecture note:
 *   NATS runs on an internal Docker network (aqua-internal) not exposed
 *   to the host. Authentication is defense-in-depth against compromised
 *   containers on the same network. Credentials are injected via env vars,
 *   NEVER embedded in the NATS_URL (nats.js does not support URL-embedded
 *   credentials — it causes TypeError: Invalid URL).
 */

/**
 * Build NATS connection options from environment variables.
 *
 * Works with both the `nats` npm package's ConnectionOptions and
 * NestJS's Transport.NATS options object. Returns a plain object
 * that can be spread into either configuration pattern.
 *
 * @param serviceName — identifies this client in NATS server logs
 * @returns Connection options with auth, reconnect, and server config
 */
export function buildNatsConnectionOptions(serviceName?: string): {
  servers: string[];
  user?: string;
  pass?: string;
  token?: string;
  name?: string;
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
} {
  const natsUrl = process.env['NATS_URL'] || 'nats://localhost:4222';
  const authUser = process.env['NATS_AUTH_USER'];
  const authPass = process.env['NATS_AUTH_PASS'];
  const authToken = process.env['NATS_AUTH_TOKEN'];

  const options: ReturnType<typeof buildNatsConnectionOptions> = {
    servers: natsUrl.split(',').map((s) => s.trim()),
    reconnect: true,
    maxReconnectAttempts: parseInt(process.env['NATS_MAX_RECONNECT_ATTEMPTS'] || '50', 10),
    reconnectTimeWait: parseInt(process.env['NATS_RECONNECT_TIME_WAIT_MS'] || '2000', 10),
    ...(serviceName ? { name: serviceName } : {}),
  };

  /** SEC-H01: Inject authentication credentials if configured. */
  if (authToken) {
    options.token = authToken;
  } else if (authUser && authPass) {
    options.user = authUser;
    options.pass = authPass;
  }

  // ── TLS Configuration ─────────────────────────────────────────────────────
  // IP-1: Enable TLS when URL scheme is tls:// or a CA cert is explicitly set.
  // On internal Docker networks with self-signed certs, CA verification
  // is relaxed (rejectUnauthorized: false) — traffic is still encrypted.
  const isTlsUrl = natsUrl.split(',').some((s) => s.trim().startsWith('tls://'));
  const tlsCaPath = process.env['NATS_TLS_CA'];

  if (isTlsUrl || tlsCaPath) {
    const tls: { rejectUnauthorized?: boolean; ca?: Buffer[] } = {};

    if (tlsCaPath) {
      try {
        const { readFileSync } = require('fs');
        tls.ca = [readFileSync(tlsCaPath)];
      } catch {
        // CA file not found — fall through to relaxed mode
      }
    }

    if (!tls.ca) {
      // WHY: Internal Docker network with self-signed cert — accept without CA.
      // Traffic is encrypted, which prevents plaintext sniffing.
      tls.rejectUnauthorized = false;
    }

    (options as Record<string, unknown>)['tls'] = tls;
  }

  return options;
}

/**
 * Build NestJS microservice Transport.NATS options.
 *
 * Returns the `options` object for ClientsModule.register() or
 * app.connectMicroservice() with Transport.NATS. Includes auth
 * credentials from environment if configured.
 *
 * Usage:
 * ```ts
 * import { buildNatsTransportOptions } from '@aquaculture/backend-common';
 *
 * ClientsModule.register([{
 *   name: 'NATS_SERVICE',
 *   transport: Transport.NATS,
 *   options: buildNatsTransportOptions('my-service'),
 * }])
 * ```
 */
export function buildNatsTransportOptions(serviceName?: string): Record<string, unknown> {
  const base = buildNatsConnectionOptions(serviceName) as Record<string, unknown>;
  const result: Record<string, unknown> = { servers: base['servers'] };
  if (base['user']) result['user'] = base['user'];
  if (base['pass']) result['pass'] = base['pass'];
  if (base['token']) result['token'] = base['token'];
  if (base['name']) result['name'] = base['name'];
  if (base['tls']) result['tls'] = base['tls'];
  return result;
}
