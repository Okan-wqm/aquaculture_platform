/**
 * myPerformanceReviews / myGoals — the viewer's own reviews and goals.
 *
 * Both lists are keyed by the HR employee id (`performance_review.employeeId`, `goal.employeeId`).
 * The JWT `sub` is an auth user id from another namespace, linked to the employee only by
 * `Employee.userId`, so handing it to the query matched nothing and the lists were always empty.
 * The resolver bridges it once and hands the query the employee id. A viewer with no employee
 * record (a tenant administrator or an owner need not have one) has nothing of their own: an empty
 * list, never an error and never the tenant-wide one.
 */
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { collaborator } from '@aquaculture/testing';
import type { EntityManager, Repository } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { Goal } from '../entities/goal.entity';
import { PerformanceReview } from '../entities/performance-review.entity';
import { PerformanceResolver } from '../performance.resolver';
import { GetMyGoalsQuery, GetMyPerformanceReviewsQuery } from '../queries';

const tenantId = 'tenant-uuid-001';
const userId = 'user-uuid-001';
const employeeId = 'employee-uuid-001';
const context = { req: { user: { sub: userId, tenantId } } };

describe('PerformanceResolver — the viewer’s own reviews and goals', () => {
  let queryBus: { execute: jest.Mock };
  let managerFindOne: jest.Mock;
  let resolver: PerformanceResolver;

  /** `viewer` is what the Employee.userId lookup finds; null is a user with no employee record. */
  const build = (viewer: Pick<Employee, 'id' | 'departmentHrId'> | null): void => {
    queryBus = { execute: jest.fn().mockResolvedValue([]) };
    managerFindOne = jest.fn().mockResolvedValue(viewer);
    const manager = collaborator<EntityManager>({ findOne: managerFindOne }, 'EntityManager');
    resolver = new PerformanceResolver(
      collaborator<CommandBus>({}, 'CommandBus'),
      collaborator<QueryBus>(queryBus, 'QueryBus'),
      collaborator<Repository<Employee>>({ manager }, 'Repository<Employee>'),
    );
  };

  const expectedEmployeeLookup = (): unknown[] => [
    Employee,
    { where: { userId, tenantId, isDeleted: false }, select: ['id', 'departmentHrId'] },
  ];

  describe('myPerformanceReviews', () => {
    it("asks for the viewer's EMPLOYEE id, never the auth user id", async () => {
      build({ id: employeeId, departmentHrId: null });
      const reviews = [Object.assign(new PerformanceReview(), { id: 'review-1', employeeId })];
      queryBus.execute.mockResolvedValue(reviews);

      const result = await resolver.getMyPerformanceReviews(context, 'FINALIZED');

      expect(managerFindOne).toHaveBeenCalledWith(...expectedEmployeeLookup());
      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetMyPerformanceReviewsQuery(tenantId, employeeId, 'FINALIZED'),
      );
      expect(result).toBe(reviews);
    });

    it('is empty, without asking the query, for a user with no employee record', async () => {
      build(null);

      const result = await resolver.getMyPerformanceReviews(context);

      expect(result).toEqual([]);
      expect(queryBus.execute).not.toHaveBeenCalled();
    });
  });

  describe('myGoals', () => {
    it("asks for the viewer's EMPLOYEE id, never the auth user id", async () => {
      build({ id: employeeId, departmentHrId: null });
      const goals = [Object.assign(new Goal(), { id: 'goal-1', employeeId })];
      queryBus.execute.mockResolvedValue(goals);

      const result = await resolver.getMyGoals(context, 'IN_PROGRESS');

      expect(managerFindOne).toHaveBeenCalledWith(...expectedEmployeeLookup());
      expect(queryBus.execute).toHaveBeenCalledWith(
        new GetMyGoalsQuery(tenantId, employeeId, 'IN_PROGRESS'),
      );
      expect(result).toBe(goals);
    });

    it('is empty, without asking the query, for a user with no employee record', async () => {
      build(null);

      const result = await resolver.getMyGoals(context);

      expect(result).toEqual([]);
      expect(queryBus.execute).not.toHaveBeenCalled();
    });
  });
});
