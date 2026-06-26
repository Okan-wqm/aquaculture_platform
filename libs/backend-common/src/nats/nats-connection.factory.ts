import { readFileSync } from 'fs';

/**
 * Canonical NATS server URL default — the SINGLE source for the localhost
 * fallback across BOTH the connection layer (this factory) and the event-bus
 * layer (`@platform/event-bus` buildEventBusConfig re-exports this; event-bus
 * already depends on backend-common, so this avoids a dependency cycle).
 */
export const DEFAULT_NATS_URL = 'nats://localhost:4222';

/**
 * SEC-H01 / IP-1 / ADR-015: Centralized NATS connection options factory.
 *
 * All services MUST use this factory to build NATS connection options.
 * This ensures consistent authentication, TLS configuration, and
 * reconnection behavior across the entire platform.
 *
 * # Authentication model (ADR-015)
 *
 * Production: mTLS cert-only. The NATS server in production mounts
 * `nats-tls-enabled.conf` with `verify_and_map: true`, which makes the
 * client certificate CN the authoritative NATS user identity. The server
 * IGNORES any `user` / `pass` / `token` fields in the CONNECT frame —
 * cert rotation IS identity rotation, atomic and unambiguous.
 *
 * Dev / CI: fallback to user/password (or no auth). `nats-tls.conf` dev
 * default has TLS disabled, so verify_and_map does not apply; servers
 * consume CONNECT-frame credentials when set.
 *
 * The factory's `authMode` return field exposes which path was selected
 * so callers and tests can verify.
 *
 * Environment variables consumed:
 *   NATS_URL                       — server address (default: nats://localhost:4222)
 *   NATS_AUTH_USER                 — dev/CI fallback username (ignored when mTLS is configured)
 *   NATS_AUTH_PASS                 — dev/CI fallback password (ignored when mTLS is configured)
 *   NATS_AUTH_TOKEN                — token-based auth (ignored when mTLS is configured)
 *   NATS_TLS_ENABLED               — MUST be set to `true` when NATS_URL is `tls://...`.
 *                                    Cross-validated against the URL scheme: mismatch
 *                                    throws immediately so misconfiguration is never silent.
 *   NATS_TLS_CA                    — filesystem path to the CA PEM bundle that signed the
 *                                    NATS server certificate. REQUIRED when NATS_URL is
 *                                    `tls://...` unless NATS_TLS_INSECURE_ALLOW=true is
 *                                    explicitly set. See TLS section below.
 *   NATS_TLS_CERT                  — filesystem path to the client certificate PEM.
 *                                    REQUIRED in production (server enforces mTLS
 *                                    with verify: true). Paired with NATS_TLS_KEY.
 *                                    Generate with infrastructure/docker/scripts/
 *                                    generate-internal-certs.sh (client-cert.pem).
 *   NATS_TLS_KEY                   — filesystem path to the client private key PEM.
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
 *
 * SECURITY (HIGH-002): `cert` and `key` are the client-side mTLS material.
 * When the server runs with `verify: true`, the client must present a
 * CA-signed cert or the handshake fails. nats.js forwards both to
 * `tls.connect()`.
 */
interface NatsTlsOptions {
  ca?: string;
  cert?: string;
  key?: string;
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
/**
 * Which auth path the factory chose. Exposed on the return object so callers
 * (bootstrap, NatsEventBus, tests) can log/verify the selected mode without
 * re-deriving it from env vars.
 *
 * - `mtls-cert`: cert-only (TLS URL + NATS_TLS_CERT/KEY present). Server
 *   runs verify_and_map; cert CN IS the NATS user identity. CONNECT-frame
 *   user/pass/token are NOT sent — server would ignore them anyway and
 *   including them obscures which field is authoritative.
 * - `token`: NATS_AUTH_TOKEN present; token-based auth on CONNECT frame.
 * - `user-pass`: NATS_AUTH_USER + NATS_AUTH_PASS present; legacy username/
 *   password auth. Kept as dev/CI fallback when mTLS isn't available.
 * - `none`: no auth (dev with TLS+auth both disabled). Only permitted when
 *   NODE_ENV !== 'production'; production throws.
 */
export type NatsAuthMode = 'mtls-cert' | 'token' | 'user-pass' | 'none';

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
  authMode: NatsAuthMode;
} {
  const natsUrl = process.env['NATS_URL'] || DEFAULT_NATS_URL;
  const authUser = process.env['NATS_AUTH_USER'];
  const authPass = process.env['NATS_AUTH_PASS'];
  const authToken = process.env['NATS_AUTH_TOKEN'];
  const certPath = process.env['NATS_TLS_CERT'];
  const keyPath = process.env['NATS_TLS_KEY'];

  const servers = natsUrl.split(',').map((s) => s.trim());
  const usesTls = servers.some((s) => s.startsWith('tls://'));
  const hasClientCert = Boolean(certPath && keyPath);
  const isProduction = process.env['NODE_ENV'] === 'production';

  // ── Authentication mode decision (ADR-015) ────────────────────────────
  //
  // Priority order, first match wins:
  //
  //   1. mTLS cert-only — production standard. Server runs verify_and_map;
  //      cert CN IS the user. Omit CONNECT-frame user/pass/token so the
  //      wire protocol is unambiguous about which field authenticated.
  //
  //   2. Token — service-account auth for external integrations (not
  //      currently used on the aquaculture platform but supported for
  //      future NATS-cluster federation scenarios).
  //
  //   3. User/password — dev + CI fallback when mTLS isn't configured.
  //      nats-tls.conf (dev default) has verify disabled, so the server
  //      DOES consume user/pass fields in this mode.
  //
  //   4. None — local dev with all auth disabled. Allowed only when
  //      NODE_ENV !== 'production'.
  //
  // Production invariant: case 4 with isProduction === true MUST throw.
  // A missing auth configuration in production is always a deploy defect
  // that must surface at startup, not silently produce an unauthenticated
  // connection.
  let authMode: NatsAuthMode;
  if (usesTls && hasClientCert) {
    authMode = 'mtls-cert';
  } else if (authToken) {
    authMode = 'token';
  } else if (authUser && authPass) {
    authMode = 'user-pass';
  } else if (isProduction) {
    throw new Error(
      '[nats-connection.factory] SECURITY: production NATS connection has no ' +
        'authentication configured. Set one of: ' +
        '(a) mTLS — NATS_URL=tls://... + NATS_TLS_CERT + NATS_TLS_KEY (recommended), ' +
        '(b) NATS_AUTH_TOKEN, ' +
        '(c) NATS_AUTH_USER + NATS_AUTH_PASS. ' +
        'Boot refuses to proceed.',
    );
  } else {
    authMode = 'none';
  }

  const options: ReturnType<typeof buildNatsConnectionOptions> = {
    servers,
    reconnect: true,
    maxReconnectAttempts: parseInt(process.env['NATS_MAX_RECONNECT_ATTEMPTS'] || '50', 10),
    reconnectTimeWait: parseInt(process.env['NATS_RECONNECT_TIME_WAIT_MS'] || '2000', 10),
    authMode,
    ...(serviceName ? { name: serviceName } : {}),
  };

  // ── Inject auth fields based on chosen mode ───────────────────────────
  //
  // NOTE: For 'mtls-cert' mode we INTENTIONALLY do NOT set user/pass/token,
  // even if those env vars happen to be populated. The server under
  // verify_and_map ignores them, and passing them anyway would make the
  // CONNECT frame misleading (operator reading a packet capture sees a
  // user field and wonders whether it's authoritative). Cert-only mode
  // means cert ONLY — one authority, no ambiguity.
  if (authMode === 'token') {
    options.token = authToken;
  } else if (authMode === 'user-pass') {
    options.user = authUser;
    options.pass = authPass;
  }
  // authMode 'mtls-cert' and 'none' → leave options.user/pass/token unset.

  // ── TLS Configuration ─────────────────────────────────────────────────
  // Hard-fail on misconfiguration — see the IP-1 docblock above for the
  // incident history that motivates the strictness.
  //
  // SECURITY: Two-layer validation.
  //   Layer 1 — URL scheme: `tls://` is the authoritative indicator that
  //             this process MUST connect over TLS. A plain `nats://` URL
  //             with `NATS_TLS_ENABLED=true` is a misconfiguration.
  //   Layer 2 — Explicit flag: NATS_TLS_ENABLED=true must agree with the
  //             URL scheme. Disagreement is always a deployment bug that
  //             would silently downgrade security or fail at runtime.
  //
  // Both layers must agree — mismatch throws immediately at startup so
  // the problem surfaces in the deploy log rather than in production traffic.
  // `usesTls` is already declared at line ~160 (auth-mode decision); reuse.
  const tlsEnabled = process.env['NATS_TLS_ENABLED'] === 'true';

  if (usesTls && !tlsEnabled) {
    throw new Error(
      '[nats-connection.factory] NATS_URL uses tls:// but NATS_TLS_ENABLED is not "true". ' +
        'Set NATS_TLS_ENABLED=true in the service environment, or change NATS_URL to nats://.',
    );
  }
  if (!usesTls && tlsEnabled) {
    throw new Error(
      '[nats-connection.factory] NATS_TLS_ENABLED=true but NATS_URL does not use tls://. ' +
        'Change NATS_URL to tls://nats:4222, or set NATS_TLS_ENABLED=false.',
    );
  }

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

      // SECURITY (HIGH-002): mTLS — load client cert + key if provided.
      // Required when the NATS server runs with `verify: true` (production
      // default after IP-1 hardening). If only one of CERT/KEY is set, throw
      // — partial config would produce a confusing "handshake failed" at
      // runtime with no hint that a pair is needed.
      // certPath + keyPath already declared at line ~156 (auth-mode decision); reuse.
      if (certPath && !keyPath) {
        throw new Error(
          '[nats-connection.factory] NATS_TLS_CERT is set but NATS_TLS_KEY is not. ' +
            'Provide both for mTLS, or unset both to fall back to one-way TLS.',
        );
      }
      if (keyPath && !certPath) {
        throw new Error(
          '[nats-connection.factory] NATS_TLS_KEY is set but NATS_TLS_CERT is not. ' +
            'Provide both for mTLS, or unset both to fall back to one-way TLS.',
        );
      }
      if (certPath && keyPath) {
        let certPem: string;
        let keyPem: string;
        try {
          certPem = readFileSync(certPath, 'utf-8');
          keyPem = readFileSync(keyPath, 'utf-8');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `[nats-connection.factory] mTLS client cert/key could not be read: ${msg}. ` +
              'Check that certs/nats/client-cert.pem and client-key.pem are ' +
              'mounted into the container and the paths match NATS_TLS_CERT / NATS_TLS_KEY.',
          );
        }
        if (!certPem.includes('BEGIN CERTIFICATE')) {
          throw new Error(
            `[nats-connection.factory] NATS_TLS_CERT at "${certPath}" is not a valid PEM ` +
              'certificate. Regenerate via infrastructure/docker/scripts/generate-internal-certs.sh.',
          );
        }
        if (!keyPem.includes('BEGIN') || !keyPem.includes('PRIVATE KEY')) {
          throw new Error(
            `[nats-connection.factory] NATS_TLS_KEY at "${keyPath}" is not a valid PEM key. ` +
              'Regenerate via infrastructure/docker/scripts/generate-internal-certs.sh.',
          );
        }
        options.tls.cert = certPem;
        options.tls.key = keyPem;
      }
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
