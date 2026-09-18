/**
 * `@Destructive()` — marks an irreversible operation (ADR-0011).
 *
 * Tenant erasure, archive and delete, legal-hold release, schema deletion,
 * audit and PII export: once done they cannot be undone, so the actor must
 * hold a FRESH MFA claim, not merely a valid session, and a live, time-boxed,
 * dual-controlled `break-glass` capability grant (ADR-0016). The decorator carries
 * its own guard — `applyDecorators(SetMetadata, UseGuards)` — so a handler
 * cannot be marked destructive without being guarded: there is no separate
 * registration to forget. The guard runs at method level, after the
 * controller-level authentication guard has put the verified principal on
 * the request.
 *
 * Enforcement of both controls follows the platform switch
 * (`platform-admin-mfa-policy.ts`): in detective mode a shortfall is recorded
 * as a security event and allowed; once `SUPER_ADMIN_MFA_ENFORCED_AT` has
 * passed it is refused.
 */
import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';

import {
  DESTRUCTIVE_KEY,
  DestructiveActionGuard,
  type DestructiveMetadata,
} from '../guards/destructive-action.guard';

export { DESTRUCTIVE_KEY } from '../guards/destructive-action.guard';

export interface DestructiveOptions {
  /** Require an MFA claim minted inside the freshness window. Default true. */
  readonly requiresFreshMfa?: boolean;
  /** Require a live `break-glass` capability grant (ADR-0016). Default true. */
  readonly requiresBreakGlass?: boolean;
  /** Why the operation is irreversible — surfaces in the security event. */
  readonly reason?: string;
}

export const Destructive = (options: DestructiveOptions = {}): MethodDecorator =>
  applyDecorators(
    SetMetadata<string, DestructiveMetadata>(DESTRUCTIVE_KEY, {
      requiresFreshMfa: options.requiresFreshMfa ?? true,
      requiresBreakGlass: options.requiresBreakGlass ?? true,
      reason: options.reason ?? null,
    }),
    UseGuards(DestructiveActionGuard),
  );
