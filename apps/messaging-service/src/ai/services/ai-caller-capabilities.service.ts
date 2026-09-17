/**
 * @module AiCallerCapabilitiesService
 * @description MSGFIX-FAZ2 2.3 — resolves a SENDER's authorization
 * capabilities (platform roles + effective tenant-RBAC resourcePermissions)
 * from auth-service over NATS, with a 60s Redis cache.
 *
 * WHY: the AI chat bridge runs from a JetStream consumer — there is NO HTTP
 * request, hence NO verified JWT to read `roles`/`resourcePermissions` from.
 * Before Faz 2 the bridge hallucinated a role bridge
 * (`(channel as {senderRoles?}).senderRoles ?? ['MODULE_USER']` — a field
 * that does not exist on Channel), forwarded nothing, and ai-service's
 * persona-tier authorization rejected every turn. This service asks
 * auth-service — the SSoT — through the same request/reply surface the
 * membership queries use (`request.auth.user.resolveCallerCapabilities`),
 * reusing the exact effective-permission read a fresh token mint performs.
 *
 * SEMANTICS:
 *   - The reply carries NO PII (role codes + `resource:action` codes only).
 *   - Tenant-scoped by the responder: a userId of another tenant is
 *     `found: false` — indistinguishable from nonexistent.
 *   - 60s Redis cache (mirrors AiPrivacyService consent-cache staleness):
 *     a revoked role/permission stops authorizing new AI turns within a
 *     minute; cache failures are transparent (fall through to NATS).
 *   - FAIL-CLOSED: unresolvable (NATS error, timeout, !success, !found,
 *     !active, malformed reply) resolves `null` — the caller must treat the
 *     sender as unauthorized, never as MODULE_USER-with-guesses.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';

import {
  AUTH_USER_QUERY_SUBJECTS,
  type ResolveCallerCapabilitiesResult,
} from '@platform/event-contracts';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/** Capabilities cache TTL — same staleness bound as the consent cache. */
const CACHE_TTL_SECONDS = 60;

/** NATS round-trip budget — shorter than the 60s chat timeout so a dead
 * auth-service degrades into "AI unavailable", not a 60s hang. */
const RESOLVE_TIMEOUT_MS = 5_000;

/** Resolved, cached caller capabilities. */
export interface CallerCapabilities {
  roles: string[];
  resourcePermissions: string[];
}

const CACHE_PREFIX = 'ai:caller-caps:';

@Injectable()
export class AiCallerCapabilitiesService {
  private readonly logger = new Logger(AiCallerCapabilitiesService.name);

  constructor(
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Resolve the (tenantId, userId) caller's capabilities, or null when they
   * cannot be established (fail-closed — caller must deny the AI turn).
   */
  async resolve(tenantId: string, userId: string): Promise<CallerCapabilities | null> {
    const cacheKey = `${CACHE_PREFIX}${tenantId}:${userId}`;

    const cached = await this.safeRedisGet(cacheKey);
    if (cached !== null) {
      const decoded = this.decode(cached);
      // A decode-able entry (capabilities or the cached empty denial) short
      // -circuits; a CORRUPT entry is treated as a miss — falling through to
      // NATS instead of fail-closing on garbage.
      if (decoded !== null) {
        return decoded;
      }
    }

    let resolved: CallerCapabilities | null = null;
    try {
      const reply: ResolveCallerCapabilitiesResult = await firstValueFrom(
        this.natsClient
          .send<ResolveCallerCapabilitiesResult>(
            AUTH_USER_QUERY_SUBJECTS.RESOLVE_CALLER_CAPABILITIES,
            { tenantId, userId },
          )
          .pipe(timeout(RESOLVE_TIMEOUT_MS)),
      );

      if (!reply?.success || !reply.found || !reply.active) {
        // Cross-tenant userId, deactivated account, or an auth-service fault:
        // all are "cannot authorize". The distinction is logged, never
        // surfaced as a different authorization verdict.
        this.logger.warn(
          `Caller capabilities unresolvable for tenant=${tenantId} user=${userId}` +
            ` (success=${String(reply?.success)} found=${String(reply?.found)} active=${String(reply?.active)})`,
        );
      } else if (
        !Array.isArray(reply.roles) ||
        !Array.isArray(reply.resourcePermissions) ||
        reply.roles.some((r) => typeof r !== 'string') ||
        reply.resourcePermissions.some((p) => typeof p !== 'string')
      ) {
        this.logger.warn(
          `Caller capabilities reply malformed for tenant=${tenantId} — failing closed`,
        );
      } else {
        resolved = {
          roles: reply.roles,
          resourcePermissions: reply.resourcePermissions,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `request.auth.user.resolveCallerCapabilities failed for tenant=${tenantId}: ${msg}`,
      );
    }

    // Cache BOTH outcomes (denial caching stops a broken responder from
    // becoming a per-message NATS storm); 60s keeps the window short.
    await this.safeRedisSetEx(
      cacheKey,
      CACHE_TTL_SECONDS,
      JSON.stringify(resolved ?? { roles: [], resourcePermissions: [] }),
    );
    return resolved;
  }

  private decode(raw: string): CallerCapabilities | null {
    try {
      const parsed = JSON.parse(raw) as CallerCapabilities;
      if (
        Array.isArray(parsed.roles) &&
        Array.isArray(parsed.resourcePermissions) &&
        parsed.roles.every((r) => typeof r === 'string') &&
        parsed.resourcePermissions.every((p) => typeof p === 'string')
      ) {
        // The empty/empty denial marker decodes to a legitimate (but
        // permission-less) shape — that is the cached denial, which the
        // caller's `ai_assistant:use` check will reject anyway.
        return parsed;
      }
    } catch {
      // Corrupt cache entry — fall through to null (caller re-resolves next
      // turn after TTL, or immediately if Redis evicts).
    }
    return null;
  }

  // ── Redis convenience wrappers — cache outage must not block resolution ──

  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis GET failed for ${key}: ${msg}`);
      return null;
    }
  }

  private async safeRedisSetEx(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.redis.setex(key, ttl, value);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis SETEX failed for ${key}: ${msg}`);
    }
  }
}
