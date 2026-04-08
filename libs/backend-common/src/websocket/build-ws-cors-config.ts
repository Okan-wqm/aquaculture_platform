import { Logger } from '@nestjs/common';

/**
 * Socket.IO CORS configuration shape returned by `buildWsCorsConfig()`.
 * Intentionally matches the subset of the Socket.IO `cors` option that
 * NestJS `@WebSocketGateway({ cors })` accepts, without importing
 * `cors` types from `@types/cors` (which would pull a DOM-ish type tree
 * into a backend library).
 */
export interface WsCorsConfig {
  origin: string[] | boolean;
  credentials: boolean;
  methods?: string[];
}

/**
 * Single source of truth for WebSocket CORS configuration across every
 * `@WebSocketGateway` in the platform. Enforces a fail-loud production
 * policy so silently misconfigured origins cannot hide in a container
 * log while clients are rejected.
 *
 * # Why this exists (H-4)
 *
 * Before this helper, each gateway defined its own private
 * `buildWsCorsConfig()` function with subtly different semantics:
 *
 *   - farm.gateway.ts  — dev default `origin: true`, prod log.error + boot (silent)
 *   - sensor-readings.gateway.ts — same pattern, same silent prod fail
 *   - messaging.gateway.ts  — same pattern, same silent prod fail
 *   - st-language.gateway.ts  — same pattern, same silent prod fail
 *
 * The pattern violated three platform rules in one function:
 *
 *   1. Module-load-time evaluation — the function is called by the
 *      `@WebSocketGateway({ cors: buildWsCorsConfig() })` decorator,
 *      which runs as soon as the module is imported. At that moment,
 *      NestJS ConfigService is not yet constructed, so only
 *      `process.env` can be read. A `.env` file loaded later by
 *      NestJS does not propagate back to the decorator.
 *
 *   2. Silent production fail-closed — if `WS_CORS_ORIGINS` was missing
 *      in production, the function returned `{ origin: false }` and
 *      the constructor logged an error. The container continued to
 *      "succeed" startup and rejected every connection. Operators
 *      discover the misconfiguration from user reports, not from
 *      deploy-time logs.
 *
 *   3. Dead dev-mode fall-through — `origin: true` with
 *      `credentials: false` accepts any browser origin in dev, which
 *      is intended, but the same function writes the same permissive
 *      config in production as a fallback if the env var was typo'd
 *      (`WS_CORS_ORIGIN` vs `WS_CORS_ORIGINS`). Silent typo trap.
 *
 * # The policy this helper enforces
 *
 *   - Production (`NODE_ENV=production`) without `WS_CORS_ORIGINS`:
 *     **throws** from module load. The process crashes before NestJS
 *     attempts to listen. Operators see a clear failure, not a
 *     "healthy" pod rejecting traffic.
 *
 *   - Production with `WS_CORS_ORIGINS` set: parses the comma-separated
 *     allowlist, enables credentials, logs the list at info.
 *
 *   - Dev without `WS_CORS_ORIGINS`: returns `{ origin: true,
 *     credentials: false }` and logs a warning once so developers know
 *     they are on the permissive path.
 *
 *   - Dev with `WS_CORS_ORIGINS` set: same allowlist behaviour as
 *     production for parity. Developers can test the strict path by
 *     setting the env var locally.
 *
 * The helper is called from the `@WebSocketGateway` decorator, which
 * runs at module load. `process.env` is the only source of truth at
 * that point — `ConfigService` does not exist yet. This is by design:
 * a pre-NestJS-bootstrap source means a misconfiguration surfaces
 * BEFORE any gateway attempts to accept a connection.
 *
 * # Usage
 *
 * ```ts
 * import { buildWsCorsConfig } from '@aquaculture/backend-common';
 *
 * @WebSocketGateway({
 *   cors: buildWsCorsConfig('FarmGateway'),
 *   namespace: '/farms',
 * })
 * export class FarmGateway { ... }
 * ```
 *
 * @param gatewayName — used in logs to disambiguate which gateway's
 *   CORS config emitted the message. Pure instrumentation, does not
 *   affect behaviour.
 */
export function buildWsCorsConfig(gatewayName: string): WsCorsConfig {
  const logger = new Logger(`WsCorsConfig:${gatewayName}`);
  const isProduction = process.env['NODE_ENV'] === 'production';
  const raw = process.env['WS_CORS_ORIGINS'] ?? '';
  const origins = raw
    ? raw
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  // Explicit allowlist — same behaviour in dev and production so
  // developers who want to test the strict path can enable it locally
  // by setting WS_CORS_ORIGINS.
  if (origins.length > 0) {
    logger.log(
      `WebSocket CORS allowlist active (${origins.length} origin${origins.length === 1 ? '' : 's'}): ${origins.join(', ')}`,
    );
    return {
      origin: origins,
      credentials: true,
      methods: ['GET', 'POST'],
    };
  }

  // No allowlist — production MUST fail fast. A silently broken
  // WebSocket gateway in production is indistinguishable from an
  // outage, and the "log error + boot" pattern the legacy code used
  // masked the real state from monitoring.
  if (isProduction) {
    const message =
      `FATAL: WS_CORS_ORIGINS must be set in production for ${gatewayName}. ` +
      `Refusing to boot because the gateway would otherwise reject every ` +
      `WebSocket connection silently. ` +
      `Set WS_CORS_ORIGINS to a comma-separated allowlist, e.g. ` +
      `WS_CORS_ORIGINS=https://app.example.com,https://admin.example.com`;
    logger.error(message);
    throw new Error(message);
  }

  // Dev permissive fallback — explicit log so developers know they
  // are on the lenient path.
  logger.warn(
    `WS_CORS_ORIGINS not set — ${gatewayName} running with permissive CORS (dev only). ` +
      `Set WS_CORS_ORIGINS to enable the strict allowlist locally.`,
  );
  return {
    origin: true,
    credentials: false,
    methods: ['GET', 'POST'],
  };
}
