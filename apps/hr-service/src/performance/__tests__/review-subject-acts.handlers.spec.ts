/**
 * submitSelfAssessment / acknowledgeReview — the reviewed employee's own acts.
 *
 * Both mutations are open to any staff member, so the handler is where "whose review is this" is
 * decided: the acting auth user must be the employee the review is about, bridged through
 * `Employee.userId` (the auth user id and the HR employee id are different uuids). Managers are NOT
 * exempt: the command carries only a user id, and a self assessment or an acknowledgement written
 * by anyone else is not the subject's.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { collaborator } from '@aquaculture/testing';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { AcknowledgeReviewCommand } from '../commands/acknowledge-review.command';
import { SubmitSelfAssessmentCommand } from '../commands/submit-self-assessment.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { AcknowledgeReviewHandler } from '../handlers/acknowledge-review.handler';
import { SubmitSelfAssessmentHandler } from '../handlers/submit-self-assessment.handler';

const tenantId = 'tenant-uuid-001';
const userId = 'user-uuid-001';
const reviewId = 'review-uuid-001';
const ownEmployeeId = 'employee-uuid-001';
const otherEmployeeId = 'employee-uuid-002';

interface Harness {
  dataSource: DataSource;
  managerFindOne: jest.Mock;
  reviewSave: jest.Mock;
  commitTransaction: jest.Mock;
  rollbackTransaction: jest.Mock;
}

/**
 * The transaction as the handlers see it. `review` is what the tenant-scoped repository finds;
 * `viewer` is what the `Employee.userId` lookup finds (null: the user has no employee record).
 */
function harness(
  review: PerformanceReview | null,
  viewer: Pick<Employee, 'id' | 'departmentHrId'> | null,
): Harness {
  const reviewSave = jest.fn().mockImplementation((entity: object) => Promise.resolve(entity));
  const reviewRepository = collaborator<Repository<PerformanceReview>>(
    {
      findOne: jest.fn().mockResolvedValue(review),
      create: jest.fn().mockImplementation((entity: object) => entity),
      save: reviewSave,
    },
    'Repository<PerformanceReview>',
  );
  const managerFindOne = jest
    .fn()
    .mockImplementation((entity: unknown) =>
      Promise.resolve(entity === Employee ? viewer : review),
    );
  const manager = collaborator<EntityManager>(
    { getRepository: jest.fn().mockReturnValue(reviewRepository), findOne: managerFindOne },
    'EntityManager',
  );
  const commitTransaction = jest.fn().mockResolvedValue(undefined);
  const rollbackTransaction = jest.fn().mockResolvedValue(undefined);
  const queryRunner = collaborator<QueryRunner>(
    {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction,
      rollbackTransaction,
      release: jest.fn().mockResolvedValue(undefined),
      manager,
    },
    'QueryRunner',
  );
  const dataSource = collaborator<DataSource>(
    { createQueryRunner: jest.fn().mockReturnValue(queryRunner) },
    'DataSource',
  );
  return { dataSource, managerFindOne, reviewSave, commitTransaction, rollbackTransaction };
}

function reviewOf(employeeId: string, status: ReviewStatus): PerformanceReview {
  return Object.assign(new PerformanceReview(), { id: reviewId, tenantId, employeeId, status });
}

const acts = [
  {
    name: 'submitSelfAssessment',
    status: ReviewStatus.SELF_ASSESSMENT,
    otherStatus: ReviewStatus.FINALIZED,
    refusal: 'Only the reviewed employee can submit the self assessment',
    run: (dataSource: DataSource): Promise<PerformanceReview> =>
      new SubmitSelfAssessmentHandler(dataSource).execute(
        new SubmitSelfAssessmentCommand(tenantId, userId, reviewId, 'I met my goals', 4),
      ),
  },
  {
    name: 'acknowledgeReview',
    status: ReviewStatus.FINALIZED,
    otherStatus: ReviewStatus.DRAFT,
    refusal: 'Only the reviewed employee can acknowledge the review',
    run: (dataSource: DataSource): Promise<PerformanceReview> =>
      new AcknowledgeReviewHandler(dataSource).execute(
        new AcknowledgeReviewCommand(tenantId, userId, reviewId, 'Noted'),
      ),
  },
];

describe.each(acts)('$name', ({ status, otherStatus, refusal, run }) => {
  it('lets the reviewed employee act on their own review', async () => {
    const own = reviewOf(ownEmployeeId, status);
    const { dataSource, reviewSave, commitTransaction } = harness(own, {
      id: ownEmployeeId,
      departmentHrId: null,
    });

    const result = await run(dataSource);

    expect(result).toBe(own);
    expect(reviewSave).toHaveBeenCalledTimes(1);
    expect(commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('bridges the acting auth user to their employee record, not the other way round', async () => {
    const { dataSource, managerFindOne } = harness(reviewOf(ownEmployeeId, status), {
      id: ownEmployeeId,
      departmentHrId: null,
    });

    await run(dataSource);

    expect(managerFindOne).toHaveBeenCalledWith(Employee, {
      where: { userId, tenantId, isDeleted: false },
      select: ['id', 'departmentHrId'],
    });
  });

  it("refuses to act on someone else's review, whoever the actor is", async () => {
    const { dataSource, reviewSave, commitTransaction, rollbackTransaction } = harness(
      reviewOf(otherEmployeeId, status),
      { id: ownEmployeeId, departmentHrId: null },
    );

    await expect(run(dataSource)).rejects.toThrow(new ForbiddenException(refusal));

    expect(reviewSave).not.toHaveBeenCalled();
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses a user with no employee record', async () => {
    const { dataSource, reviewSave } = harness(reviewOf(ownEmployeeId, status), null);

    await expect(run(dataSource)).rejects.toThrow(new ForbiddenException(refusal));

    expect(reviewSave).not.toHaveBeenCalled();
  });

  it("refuses before the review's state is looked at, so a stranger learns nothing of it", async () => {
    const { dataSource } = harness(reviewOf(otherEmployeeId, otherStatus), {
      id: ownEmployeeId,
      departmentHrId: null,
    });

    await expect(run(dataSource)).rejects.toThrow(ForbiddenException);
  });

  it('still reports a review that does not exist as not found', async () => {
    const { dataSource, managerFindOne } = harness(null, null);

    await expect(run(dataSource)).rejects.toThrow(NotFoundException);

    expect(managerFindOne).not.toHaveBeenCalled();
  });
});
