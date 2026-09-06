import { Role } from '@aquaculture/backend-common/decorators';
import { ForbiddenException } from '@nestjs/common';
import type { EntityManager, FindOptionsWhere, Repository } from 'typeorm';

import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { User } from '../../authentication/entities/user.entity';
import type { UserTokenInvalidationIntent } from '../../authentication/services/durable-user-token-invalidation.service';

export type UserCredentialInvalidationOperation =
  | 'user-delete'
  | 'admin-password-reset'
  | 'admin-user-deactivate'
  | 'admin-user-authorization-update'
  | 'admin-force-logout'
  | 'tenant-user-deactivate'
  // ADR-046: a tenant turning MFA enforcement on terminates the sessions of
  // its users that carry no second factor, so their next login walks the
  // enrollment gate instead of resuming an unenrolled session.
  | 'tenant-mfa-enforcement-enabled';

/**
 * Canonical transaction fence for tenant-owned credential mutations.
 *
 * Every refresh-token mint/rotation and revocation path takes the User row
 * before touching RefreshToken rows. The stable per-user lock closes the
 * snapshot gap where a concurrent mint could insert a replacement token just
 * after a set-based revocation UPDATE completed.
 */
export async function lockUserForCredentialMutation(
  manager: EntityManager,
  userRepository: Repository<User>,
  userId: string,
  tenantId?: string,
): Promise<User | null> {
  const where: FindOptionsWhere<User> =
    tenantId === undefined ? { id: userId } : { id: userId, tenantId };
  return manager.withRepository(userRepository).findOne({
    where,
    lock: { mode: 'pessimistic_write' },
  });
}

/**
 * Locks active refresh-token rows only after the canonical User lock, then
 * revokes the same predicate with one transaction-bound UPDATE.
 *
 * The explicit ordered lock makes the cross-path lock sequence observable and
 * deterministic. The User fence is what also serializes a concurrent INSERT.
 */
export async function revokeActiveRefreshTokens(
  manager: EntityManager,
  refreshTokenRepository: Repository<RefreshToken>,
  userId: string,
  revokedAt: Date,
  revokedReason: string,
): Promise<number> {
  const repository = manager.withRepository(refreshTokenRepository);
  await repository
    .createQueryBuilder('refreshToken')
    .select('refreshToken.id')
    .where('refreshToken.userId = :userId', { userId })
    .andWhere('refreshToken.isRevoked = :isRevoked', { isRevoked: false })
    .orderBy('refreshToken.id', 'ASC')
    .setLock('pessimistic_write')
    .getMany();

  const result = await repository.update(
    { userId, isRevoked: false },
    { isRevoked: true, revokedAt, revokedReason },
  );
  return result.affected ?? 0;
}

export function resolveCredentialInvalidationTenant(user: User): string | null {
  if (user.tenantId) {
    return user.tenantId;
  }
  if (user.role === Role.SUPER_ADMIN) {
    return null;
  }
  throw new ForbiddenException('Tenant-scoped user has no tenant identity');
}

export function createCredentialInvalidationIntent(
  user: User,
  invalidatedAt: Date,
  operation: UserCredentialInvalidationOperation,
  reason: UserTokenInvalidationIntent['reason'],
): UserTokenInvalidationIntent {
  return {
    userId: user.id,
    tenantId: resolveCredentialInvalidationTenant(user),
    invalidatedAt,
    reason,
    idempotencyKey: `${operation}:${user.id}:${invalidatedAt.getTime()}`,
  };
}
