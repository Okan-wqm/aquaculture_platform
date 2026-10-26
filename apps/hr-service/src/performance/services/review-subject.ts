/**
 * Self assessment and acknowledgement are the reviewed employee's own acts. Both mutations are open
 * to any staff member, so the handler decides whose review it is: the acting auth user must be the
 * employee the review is about. The command carries only a user id, so no role can exempt a manager
 * (a manager writes the manager assessment, which has its own operation).
 */
import type { EntityManager } from 'typeorm';

import { assertOwnRecord, findViewerEmployee } from '../../common/viewer';
import type { PerformanceReview } from '../entities/performance-review.entity';

/**
 * Refuses unless the acting user's employee record is the one the review is about. A user with no
 * employee record has no review of their own, so they are refused too. `manager` is the manager of
 * the handler's transaction, so the lookup reads the same snapshot as the review.
 */
export async function assertActingAsReviewedEmployee(
  manager: EntityManager,
  tenantId: string,
  userId: string,
  review: Pick<PerformanceReview, 'employeeId'>,
  deniedMessage: string,
): Promise<void> {
  const viewerEmployee = await findViewerEmployee(manager, tenantId, { sub: userId });
  assertOwnRecord(viewerEmployee, review.employeeId, deniedMessage);
}
