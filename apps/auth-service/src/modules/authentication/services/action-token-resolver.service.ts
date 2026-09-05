/**
 * ActionTokenResolver — the ONE way an emailed link segment becomes a token
 * lookup (SEC-HIGH-056).
 *
 * WHY: the invitation e-mail carries `/accept-invitation/{actionToken.id}`
 * (a row PK minted by InternalAuthController), but `validateInvitation`
 * hashed that segment and looked it up as an invitation token — a UUID never
 * matches a SHA-256, so every invitation rendered the "invalid" screen while
 * `acceptInvitation` and `resetPassword`, which DID resolve the ActionToken
 * first, would have accepted the same link. Three consumers, three hand-rolled
 * resolutions, one of them wrong. Routing every consumer through this class
 * makes a consumer that skips the indirection impossible to write: the
 * segment's shape decides the lookup, not the caller.
 *
 * Resolution rules:
 *   - a UUID segment is an ActionToken row id (purpose-scoped). A UUID is
 *     NEVER hashed and never falls through to the raw-token path: an id with
 *     no row is `unresolvable`, not "maybe a raw token".
 *   - a 64-hex segment is a RAW token from a link e-mailed before the
 *     ActionToken indirection shipped (invitations live 7 days, resets 1 h).
 *     It resolves to its SHA-256 for the legacy `Invitation.token` /
 *     `User.passwordResetToken` lookups. This branch is retired under
 *     SEC-LOW-060 once those links have expired.
 *   - anything else is `unresolvable` without touching the database.
 */
import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ActionToken, ActionTokenPurpose } from '../entities/action-token.entity';

export type ActionLinkResolution =
  | { readonly kind: 'action-token'; readonly actionToken: ActionToken }
  | { readonly kind: 'raw-token'; readonly tokenHash: string }
  | { readonly kind: 'unresolvable' };

export type ActionLinkLock = 'none' | 'pessimistic_write';

/** The frontend route each purpose redeems on (web/shell App.tsx). */
export const ACTION_LINK_PATH: Readonly<Record<ActionTokenPurpose, string>> = {
  [ActionTokenPurpose.INVITATION]: 'accept-invitation',
  [ActionTokenPurpose.PASSWORD_RESET]: 'reset-password',
};

@Injectable()
export class ActionTokenResolver {
  /** ActionToken row ids are uuid PKs (any RFC 4122 version). */
  static readonly ACTION_TOKEN_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Raw tokens are `randomBytes(32).toString('hex')` — exactly 64 hex chars. */
  static readonly RAW_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

  async resolve(
    segment: string,
    purpose: ActionTokenPurpose,
    manager: EntityManager,
    lock: ActionLinkLock,
  ): Promise<ActionLinkResolution> {
    if (ActionTokenResolver.ACTION_TOKEN_ID_PATTERN.test(segment)) {
      // Pre-tenant auth flow: the link IS the credential, so the lookup is
      // cross-tenant by construction (the same rationale as
      // AuthenticationService.preTenantAuthRepository). EntityManager.findOne
      // keeps that explicit without a repository handle.
      const actionToken = await manager.findOne(ActionToken, {
        where: { id: segment, purpose },
        ...(lock === 'pessimistic_write' ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
      return actionToken ? { kind: 'action-token', actionToken } : { kind: 'unresolvable' };
    }

    if (ActionTokenResolver.RAW_TOKEN_PATTERN.test(segment)) {
      return { kind: 'raw-token', tokenHash: this.hashRawToken(segment) };
    }

    return { kind: 'unresolvable' };
  }

  /** The only place a URL segment is hashed (SEC-005 hashed-at-rest tokens). */
  hashRawToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  urlPathFor(purpose: ActionTokenPurpose): string {
    return ACTION_LINK_PATH[purpose];
  }

  /** The emailed link: the row id, never the token hash or the raw secret. */
  buildActionUrl(frontendUrl: string, actionToken: ActionToken): string {
    return `${frontendUrl}/${this.urlPathFor(actionToken.purpose)}/${actionToken.id}`;
  }
}
