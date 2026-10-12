import { BypassRlsService, bindTenantRlsContext } from '@aquaculture/backend-common/database';
import { requestContextStorage, getRequestContext } from '@aquaculture/backend-common/logging';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuthPayload } from '../dto/auth-response.dto';
import { User } from '../entities/user.entity';
import { TokenService, type GenerateTokensOptions } from './token.service';

/**
 * The single RLS boundary for authentication flows that run BEFORE a tenant
 * context can exist.
 *
 * WHY THIS CLASS EXISTS (the 2026-10-12 invitation outage): `auth` tables
 * that carry a tenantId column are covered by `tenant_isolation_policy`
 * (`FOR ALL … USING (bypass OR "tenantId" = app.current_tenant)`), armed with
 * FORCE by db-migrate. An anonymous request has no JWT and no x-tenant-id,
 * so the pool checkout emits empty GUCs and every read of
 * `auth.action_tokens` / `auth.invitations` returns ZERO rows — a perfectly
 * valid invitation rendered "invalid", and the password-reset ActionToken
 * INSERT was refused and swallowed. This is the fourth incident of the class
 * (auth.users login 2026-04-21, refresh_tokens rotation, tenant provisioning
 * receipts 2026-08-06, invitations+reset today); each time the fix landed as
 * one more hand-rolled frame at one more call site. This service is the
 * structural version: the pre-auth phase has ONE audited API, and the
 * `auth-preauth-rls-context-ssot` invariant makes an unframed call site
 * un-mergeable.
 *
 * Two shapes, mirroring login's DEPLOY-CRITICAL-007 decision:
 *
 *  - Token flows (`runPreAuthTokenFlow`): the emailed/bearer segment IS the
 *    credential, so its resolution is cross-tenant by construction — the
 *    hash/bcrypt match on the exact token is the authorization. These run
 *    under the audit-logged `BypassRlsService.withBypass` (the refresh-token
 *    rotation precedent).
 *
 *  - Known-principal writes (`runTenantCredentialWrite`) and mints
 *    (`mintTokensForPrincipal`): the tenant is derived from a row that was
 *    already authenticated (the user record), so the work runs under that
 *    tenant's bound context — no bypass. A platform principal (tenantId
 *    NULL) can satisfy no tenant predicate at any GUC value and takes the
 *    audited bypass instead.
 *
 * SEQUENCING CONTRACT: `mintTokensForPrincipal` must be awaited AFTER any
 * `runPreAuthTokenFlow` callback has returned, never inside it — a frame
 * nested in a bypass frame inherits `bypassRls: true` (the context is
 * spread, not replaced) and would silently mint under bypass.
 */
@Injectable()
export class PreAuthRlsFrameService {
  constructor(
    private readonly bypassRls: BypassRlsService,
    private readonly tokenService: TokenService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The label set is closed so a typo cannot mint an ungreppable bypass.
   * Adding a flow means adding it here, next to its siblings.
   */
  runPreAuthTokenFlow<T>(
    operation:
      | 'invitation-validation'
      | 'invitation-redemption'
      | 'password-reset-request'
      | 'password-reset-redemption',
    work: () => Promise<T> | T,
  ): Promise<T> {
    return this.bypassRls.withBypass(`auth-service:${operation}`, work);
  }

  /**
   * Run a credential-mutating transaction bound to a known tenant. The
   * context is bound transaction-locally with a fail-closed read-back
   * (`bindTenantRlsContext`), so a connection that resolved elsewhere fails
   * loudly instead of writing invisibly — the same boundary
   * `inCredentialWriterContext` established for platform-capability writes.
   */
  async runTenantCredentialWrite<T>(
    tenantId: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await bindTenantRlsContext(manager, tenantId, 'auth');
      return work(manager);
    });
  }

  /**
   * Mint a session for a principal whose tenant is already known from its
   * row. `generateTokens` opens its OWN transaction and checks connections
   * out for its claim reads, so every checkout must happen inside the frame
   * this method establishes — pass the bare user, never a manager from an
   * outer transaction (that connection's GUCs were fixed at ITS checkout).
   */
  mintTokensForPrincipal(
    user: User,
    ipAddress?: string,
    userAgent?: string,
    options?: GenerateTokensOptions,
  ): Promise<AuthPayload> {
    return user.tenantId
      ? requestContextStorage.run(
          { ...getRequestContext(), tenantId: user.tenantId, userId: user.id },
          () => this.tokenService.generateTokens(user, ipAddress, userAgent, options),
        )
      : this.bypassRls.withBypass('auth-service:platform-session-mint', () =>
          this.tokenService.generateTokens(user, ipAddress, userAgent, options),
        );
  }
}
