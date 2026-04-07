import { readFileSync } from 'fs';

/**
 * SEC-H01 / IP-1: Centralized NATS connection options factory.
 *
 * All services MUST use this factory to build NATS connection options.
 * This ensures consistent authentication, TLS configuration, and
 * reconnection behavior across the entire platform.
 *
 * Environment variables consumed:
 *   NATS_URL                       — server address (default: nats://localhost:4222)
 *   NATS_AUTH_USER                 — username for NATS authorization block
 *   NATS_AUTH_PASS                 — password for NATS authorization block
 *   NATS_AUTH_TOKEN                — token-based auth (alternative to user/pass)
 *   NATS_TLS_CA                    — filesystem path to the CA PEM bundle that signed the
 *                                    NATS server certificate. REQUIRED when NATS_URL is
 *                                    `tls://...` unless NATS_TLS_INSECURE_ALLOW=true is
 *                                    explicitly set. See TLS section below.
 *   NATS_TLS_INSECURE_ALLOW        — set to `true` to disable TLS hard-failure when
 *                                    no CA is supplied. Only intended for local-dev
 *                                    smoke tests. NEVER enable in production.
 *   NATS_MAX_RECONNECT_ATTEMPTS    — default 50
 *   NATS_RECONNECT_TIME_WAIT_MS    — default 2000
 *
 * Architecture note:
 *   NATS runs on an internal Docker network (aqua-internal) not exposed
 *   to the host. Authentication is defense-in-depth against compromised
 *   containers on the same network. Credentials are injected via env vars,
 *   NEVER embedded in the NATS_URL (nats.js does not support URL-embedded
 *   credentials — it causes TypeError: Invalid URL).
 *
 * # TLS — and why the previous revision of this file was silently broken
 *
 * The previous revision built a `tls` option with `rejectUnauthorized: false`
 * and a swallowed `catch {}` around the CA read. Both decisions were wrong:
 *
 * 1. `rejectUnauthorized` is NOT part of nats.js's `TlsOptions` schema.
 *    nats.js only accepts `{ ca, caFile, cert, certFile, key, keyFile,
 *    handshakeFirst }` and forwards those to `tls.connect()`. The
 *    `rejectUnauthorized` field was silently dropped by the nats.js
 *    option validator, leaving the Node TLS default (strict verification)
 *    in place. Every TLS connection attempt on the platform was failing
 *    with `unable to verify the first certificate` because the NATS
 *    server cert is signed by the self-signed `Aquaculture Internal CA`,
 *    which is not in the container's system trust store.
 *
 * 2. The `try { readFileSync(...) } catch {}` block swallowed any error
 *    from a missing CA file and fell through to the (also broken)
 *    rejectUnauthorized path, producing connections that *looked* TLS-
 *    enabled but were actually in a hard-failing loop — visible only
 *    in per-service logs, never in deploy health checks. farm-service
 *    alone logged 7 reconnect cycles before the deploy at
 *    2026-04-07T14:49Z was cancelled. NATS was effectively offline
 *    across the entire service mesh in every production deploy since
 *    TLS was enabled.
 *
 * The fix is two-part:
 *
 *   A) Produce nats.js-shaped TLS options (`ca` holding the PEM bundle
 *      as a UTF-8 string, which is what nats.js forwards to
 *      `tls.connect({ ca })`).
 *
 *   B) Hard-fail on any misconfiguration. If `NATS_URL` starts with
 *      `tls://`, the CA MUST be available — either via `NATS_TLS_CA`
 *      pointing at a readable file, or via the explicit escape hatch
 *      `NATS_TLS_INSECURE_ALLOW=true` for local-dev smoke tests. Silent
 *      fallback modes produce the exact class of "works for a while
 *      until it catastrophically doesn't" bug we just burned a full
 *      day of incident response on.
 */

/**
 * TLS options shape that nats.js and `tls.connect()` both understand.
 * `ca` is a PEM bundle as a UTF-8 string; this matches both the nats.js
 * `TlsOptions.ca` field and Node's `tls.connect({ ca })` overload for a
 * single CA chain.
 */
interface NatsTlsOptions {
  ca?: string;
}

/**
 * Build NATS connection options from environment variables.
 *
 * Works with both the `nats` npm package's ConnectionOptions and
 * NestJS's Transport.NATS options object. Returns a plain object
 * that can be spread into either configuration pattern.
 *
 * @param serviceName — identifies this client in NATS server logs
 * @returns Connection options with auth, reconnect, TLS, and server config
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
  tls?: NatsTlsOptions;
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

  // ── TLS Configuration ─────────────────────────────────────────────────
  // Hard-fail on misconfiguration — see the IP-1 docblock above for the
  // incident history that motivates the strictness.
  const usesTls = options.servers.some((s) => s.startsWith('tls://'));
  if (usesTls) {
    const caPath = process.env['NATS_TLS_CA'];
    const insecureAllow = process.env['NATS_TLS_INSECURE_ALLOW'] === 'true';

    if (caPath) {
      // Load the CA bundle as a PEM string. Failures here are fatal —
      // a misconfigured CA path on a tls:// URL is almost certainly a
      // deployment bug that must surface immediately.
      const prefix = `[nats-connection.factory] NATS_TLS_CA is set to "${caPath}" but`;
      let caPem: string;
      try {
        caPem = readFileSync(caPath, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${prefix} the file could not be read: ${msg}. ` +
            `Check that the deploy script mounts /etc/ssl/nats-ca.pem ` +
            `(or the path you configured) into the container from ` +
            `./certs/nats/ca-cert.pem on the host.`,
        );
      }
      if (!caPem.includes('BEGIN CERTIFICATE')) {
        throw new Error(
          `${prefix} the file does not look like a PEM certificate — no ` +
            `BEGIN CERTIFICATE marker found. Re-run ` +
            `infrastructure/docker/scripts/generate-internal-certs.sh ` +
            `to regenerate the CA bundle.`,
        );
      }
      options.tls = { ca: caPem };
    } else if (!insecureAllow) {
      // No CA and no explicit opt-in to insecure mode — refuse to
      // produce a connection that would fail at handshake time with
      // a misleading "unable to verify the first certificate" error.
      throw new Error(
        '[nats-connection.factory] NATS_URL uses tls:// but no NATS_TLS_CA is ' +
          'configured. Set NATS_TLS_CA to the path of the CA PEM bundle that ' +
          'signed the NATS server certificate (e.g. /etc/ssl/nats-ca.pem mounted ' +
          'from ./certs/nats/ca-cert.pem). For local-dev smoke tests only, set ' +
          'NATS_TLS_INSECURE_ALLOW=true to bypass this check — do NOT use that ' +
          'flag in any environment that talks to a real NATS broker.',
      );
    }
    // insecureAllow && !caPath → leave options.tls unset, which tells
    // nats.js to use Node's default trust store (system CAs). That's
    // the only situation in which the client can connect to a TLS NATS
    // without an explicit CA, and it only works against commercially-
    // signed certs — useless for this platform's self-signed setup, so
    // treat it as a deliberate local-dev escape hatch.
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
  const base = buildNatsConnectionOptions(serviceName);
  const result: Record<string, unknown> = { servers: base.servers };
  if (base.user !== undefined) result['user'] = base.user;
  if (base.pass !== undefined) result['pass'] = base.pass;
  if (base.token !== undefined) result['token'] = base.token;
  if (base.name !== undefined) result['name'] = base.name;
  if (base.tls !== undefined) result['tls'] = base.tls;
  return result;
}
