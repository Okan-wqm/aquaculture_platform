import { Repository } from 'typeorm';

import { UserSiteAssignment } from '../entities/user-site-assignment.entity';

export interface EffectiveUserSiteAssignmentRead {
  assignments: UserSiteAssignment[];
  siteIds: string[];
  earliestExpiresAt: Date | null;
}

export interface EffectiveUserSiteAssignmentReadOptions {
  /** Must be used only inside an open transaction. */
  lock?: 'pessimistic_read';
}

/** Exact SSoT predicate: an expiry equal to `at` is no longer effective. */
export function isEffectiveUserSiteAssignmentAt(
  assignment: Pick<UserSiteAssignment, 'isActive' | 'expiresAt'>,
  at: Date,
): boolean {
  if (!assignment.isActive || !Number.isFinite(at.getTime())) {
    return false;
  }
  if (assignment.expiresAt === null) {
    return true;
  }
  return (
    assignment.expiresAt instanceof Date &&
    Number.isFinite(assignment.expiresAt.getTime()) &&
    assignment.expiresAt.getTime() > at.getTime()
  );
}

/**
 * Canonical effective-assignment reader shared by JWT minting and tenant admin.
 * The single strict boundary is `expiresAt IS NULL OR expiresAt > at`.
 */
export async function readEffectiveUserSiteAssignments(
  repository: Repository<UserSiteAssignment>,
  userId: string,
  tenantId: string,
  at: Date,
  options: EffectiveUserSiteAssignmentReadOptions = {},
): Promise<EffectiveUserSiteAssignmentRead> {
  const candidates = options.lock
    ? await repository
        .createQueryBuilder('assignment')
        .where('assignment.userId = :userId', { userId })
        .andWhere('assignment.tenantId = :tenantId', { tenantId })
        .andWhere('assignment.isActive = true')
        .orderBy('assignment.siteId', 'ASC')
        .setLock(options.lock)
        .getMany()
    : await repository.find({
        where: { userId, tenantId, isActive: true },
        order: { siteId: 'ASC' },
      });
  const assignments = candidates.filter((assignment) =>
    isEffectiveUserSiteAssignmentAt(assignment, at),
  );
  const expirations = assignments
    .map((assignment) => assignment.expiresAt)
    .filter((expiresAt): expiresAt is Date => expiresAt instanceof Date);
  const earliestExpiresAt =
    expirations.length === 0
      ? null
      : new Date(Math.min(...expirations.map((expiresAt) => expiresAt.getTime())));

  return {
    assignments,
    siteIds: assignments.map((assignment) => assignment.siteId),
    earliestExpiresAt,
  };
}
