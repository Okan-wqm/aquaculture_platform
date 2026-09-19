import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_USER_QUERY_SUBJECTS,
  type ResolveCallerCapabilitiesQuery,
  type ResolveCallerCapabilitiesResult,
  validateResolveCallerCapabilitiesQuerySchema,
} from '@platform/event-contracts';

import { TokenService } from '../services/token.service';

/**
 * MSGFIX-FAZ2 2.3 — caller-capabilities NATS responder
 * (request.auth.user.resolveCallerCapabilities).
 *
 * Answers exactly one question for a non-HTTP caller: "which authorization
 * capabilities does this tenant user hold RIGHT NOW?" — the same `roles` +
 * effective `resourcePermissions` a fresh JWT would stamp, resolved through
 * TokenService's single SSoT read path (auth.user_role_assignments →
 * tenant_role_permissions → per-user overrides ∩ licensed capabilities).
 *
 * Consumers: messaging-service's AI chat bridge, which triggers from a
 * JetStream MessageSent consumer (no HTTP request → no verified JWT) and must
 * authorize the SENDER before their content is forwarded to ai-service.
 *
 * Security posture (mirrors auth-user-query-nats.handler.ts):
 *   - Tenant-scoped by construction: a userId under ANOTHER tenant resolves
 *     `found: false` exactly like a nonexistent one — no cross-tenant
 *     capability probing, no platform-wide existence leak.
 *   - NO PII in the reply — role codes and `resource:action` permission
 *     codes are catalogue constants. The AJV result schema
 *     (additionalProperties:false) is the lock that keeps it that way.
 *   - NATS payloads are a trust boundary: the compiled query schema rejects
 *     malformed/extra-key payloads BEFORE any field is read.
 *   - Authorization-read failures surface as `success: false` (INTERNAL_ERROR)
 *     — callers fail CLOSED, never treat a fault as "no capabilities".
 */
@Controller()
export class AuthCallerCapabilitiesNatsHandler {
  private readonly logger = new Logger(AuthCallerCapabilitiesNatsHandler.name);

  constructor(private readonly tokenService: TokenService) {}

  @MessagePattern(AUTH_USER_QUERY_SUBJECTS.RESOLVE_CALLER_CAPABILITIES)
  async resolveCallerCapabilities(
    @Payload() payload: ResolveCallerCapabilitiesQuery,
  ): Promise<ResolveCallerCapabilitiesResult> {
    if (!validateResolveCallerCapabilitiesQuerySchema(payload)) {
      return {
        success: false,
        found: false,
        active: false,
        roles: [],
        resourcePermissions: [],
        errorCode: 'VALIDATION_ERROR',
        error: 'Invalid caller-capabilities query payload',
      };
    }

    try {
      const resolved = await this.tokenService.resolveCallerCapabilities(
        payload.tenantId,
        payload.userId,
      );

      if (!resolved.found) {
        // Tenant-scoped miss: identical answer for "no such user" and "user
        // of another tenant" — log tenant only, never the probed userId, so
        // operational logs cannot be turned into a cross-tenant oracle.
        this.logger.warn(`resolveCallerCapabilities: no user for tenant=${payload.tenantId}`);
      }

      return { success: true, ...resolved };
    } catch (error) {
      this.logger.error(
        `resolveCallerCapabilities failed for tenant=${payload.tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        success: false,
        found: false,
        active: false,
        roles: [],
        resourcePermissions: [],
        errorCode: 'INTERNAL_ERROR',
        error: 'Unable to resolve caller capabilities',
      };
    }
  }
}
