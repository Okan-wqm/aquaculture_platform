/**
 * GetMyPerformanceReviews / GetMyGoals — what the handlers filter by.
 *
 * The query carries an HR EMPLOYEE id (the resolver bridges it from the auth user id), and the
 * handler compares it with `employeeId` of the review / goal: the same namespace on both sides.
 */
import type { Repository } from 'typeorm';

import { Goal } from '../entities/goal.entity';
import { PerformanceReview } from '../entities/performance-review.entity';
import { GetMyGoalsQuery, GetMyPerformanceReviewsQuery } from '../queries';
import { GetMyGoalsHandler } from '../query-handlers/get-my-goals.handler';
import { GetMyPerformanceReviewsHandler } from '../query-handlers/get-my-performance-reviews.handler';

const tenantId = 'tenant-uuid-001';
const employeeId = 'employee-uuid-001';

type QueryBuilderDouble = Record<string, jest.Mock>;

/** A chainable query-builder double whose awaited end is `getMany`. */
function queryBuilderDouble(rows: unknown[]): QueryBuilderDouble {
  const queryBuilder: QueryBuilderDouble = {};
  for (const method of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy']) {
    queryBuilder[method] = jest.fn(() => queryBuilder);
  }
  queryBuilder['getMany'] = jest.fn().mockResolvedValue(rows);
  return queryBuilder;
}

function repositoryOf<Entity extends object>(queryBuilder: QueryBuilderDouble): Repository<Entity> {
  const partial: Partial<Repository<Entity>> = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  };
  return partial as Repository<Entity>;
}

describe('GetMyPerformanceReviewsHandler', () => {
  it('lists the reviews of the employee, inside the tenant', async () => {
    const reviews = [Object.assign(new PerformanceReview(), { id: 'review-1', employeeId })];
    const queryBuilder = queryBuilderDouble(reviews);
    const handler = new GetMyPerformanceReviewsHandler(
      repositoryOf<PerformanceReview>(queryBuilder),
    );

    const result = await handler.execute(new GetMyPerformanceReviewsQuery(tenantId, employeeId));

    expect(queryBuilder['where']).toHaveBeenCalledWith('pr.tenantId = :tenantId', { tenantId });
    expect(queryBuilder['andWhere']).toHaveBeenCalledWith('pr.employeeId = :employeeId', {
      employeeId,
    });
    expect(result).toBe(reviews);
  });

  it('narrows to a status when one is given', async () => {
    const queryBuilder = queryBuilderDouble([]);
    const handler = new GetMyPerformanceReviewsHandler(
      repositoryOf<PerformanceReview>(queryBuilder),
    );

    await handler.execute(new GetMyPerformanceReviewsQuery(tenantId, employeeId, 'FINALIZED'));

    expect(queryBuilder['andWhere']).toHaveBeenCalledWith('pr.status = :status', {
      status: 'FINALIZED',
    });
  });
});

describe('GetMyGoalsHandler', () => {
  it('lists the goals of the employee, inside the tenant', async () => {
    const goals = [Object.assign(new Goal(), { id: 'goal-1', employeeId })];
    const queryBuilder = queryBuilderDouble(goals);
    const handler = new GetMyGoalsHandler(repositoryOf<Goal>(queryBuilder));

    const result = await handler.execute(new GetMyGoalsQuery(tenantId, employeeId));

    expect(queryBuilder['where']).toHaveBeenCalledWith('g.tenantId = :tenantId', { tenantId });
    expect(queryBuilder['andWhere']).toHaveBeenCalledWith('g.employeeId = :employeeId', {
      employeeId,
    });
    expect(result).toBe(goals);
  });

  it('narrows to a status when one is given', async () => {
    const queryBuilder = queryBuilderDouble([]);
    const handler = new GetMyGoalsHandler(repositoryOf<Goal>(queryBuilder));

    await handler.execute(new GetMyGoalsQuery(tenantId, employeeId, 'IN_PROGRESS'));

    expect(queryBuilder['andWhere']).toHaveBeenCalledWith('g.status = :status', {
      status: 'IN_PROGRESS',
    });
  });
});
