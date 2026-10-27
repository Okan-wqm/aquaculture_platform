/**
 * Cutting the live tokens of members whose module access changed (PKG-06; RBAC-HIGH-035;
 * ADR-051 §2 "Change", the projected claim with durable invalidation of ADR-0016).
 *
 * WHY: a grant change or a removed module wrote rows and nothing else, so every live access
 * token kept the module until it expired, while a site-assignment change already enqueued a
 * durable invalidation. The claim is projected: the next mint reads the grants, so cutting the
 * access token is what makes a change take effect.
 *
 * WHAT: `enqueueModuleAccessInvalidations` writes one durable invalidation intent per member
 * through the caller's transaction, so the grant write and the recovery signal commit together.
 * Its reason is role_permissions_changed, as for ADR-0016's capability grants
 * (platform-capability.service.ts): a module grant is a role, and an existing reason keeps the
 * event contract unchanged, so the auth consumer of every release accepts it (C5).
 * `applyModuleAccessInvalidations` cuts the live tokens after commit on the request path; a
 * failure there is logged and the committed intent is replayed by the auth consumer. Refresh
 * tokens are not revoked: the member's next refresh mints a token with the new grants, as after a
 * site-assignment change.
 *
 * The event enqueued here (UserAccessTokenInvalidationRequested: the tenant and the member) is
 * also the capability-cache eviction event of ADR-051 §2 "Change": the one durable record that a
 * member's projected authorization changed, so no second event carries the same fact. Its
 * consumer is messaging-service's caller-capability cache, which starts caching moduleAccess with
 * plan package PKG-25 PR2 ("the capability cache is evicted when a grant changes"); that cache
 * holds roles and resourcePermissions only, which no grant write changes.
 */
import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type {
  DurableUserTokenInvalidationService,
  UserTokenInvalidationIntent,
} from '../../authentication/services/durable-user-token-invalidation.service';

import {
  createCredentialInvalidationIntent,
  type CredentialInvalidationTarget,
  type UserCredentialInvalidationOperation,
} from './user-credential-revocation';

/** A member whose module access changed: a loaded User or a row RemoveModule selected. */
export type ModuleAccessHolder = CredentialInvalidationTarget;

export async function enqueueModuleAccessInvalidations(
  manager: EntityManager,
  durable: DurableUserTokenInvalidationService,
  members: Iterable<ModuleAccessHolder>,
  operation: Extract<
    UserCredentialInvalidationOperation,
    'module-access-changed' | 'tenant-module-removed'
  >,
  invalidatedAt: Date,
): Promise<UserTokenInvalidationIntent[]> {
  const intents: UserTokenInvalidationIntent[] = [];
  for (const member of members) {
    const intent = createCredentialInvalidationIntent(
      member,
      invalidatedAt,
      operation,
      'role_permissions_changed',
    );
    await durable.enqueue(manager, intent);
    intents.push(intent);
  }
  return intents;
}

export async function applyModuleAccessInvalidations(
  durable: DurableUserTokenInvalidationService,
  intents: readonly UserTokenInvalidationIntent[],
  logger: Logger,
): Promise<void> {
  for (const intent of intents) {
    try {
      await durable.applyImmediately(intent);
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: 'module_access_immediate_invalidation_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }
}
