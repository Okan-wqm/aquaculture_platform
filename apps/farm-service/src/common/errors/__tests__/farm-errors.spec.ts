/**
 * FarmAppError + concrete subclasses + filter Unit Tests
 *
 * Verifies:
 *   - Each subclass carries the expected stable code, status, and
 *     structured context shape so a downstream string-match on the
 *     code acts as a contract.
 *   - HttpException compatibility: `instanceof HttpException` still
 *     holds so legacy catchers across backend-common keep working.
 *   - Filter produces the documented GraphQL extensions envelope
 *     (code, userMessage, fieldPath, retryable, context, correlationId).
 *   - Non-GraphQL hosts re-throw the original exception so the HTTP
 *     exception chain is not short-circuited.
 */
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { GqlContextType } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

import {
  BackdateBlockedError,
  BatchWithdrawalBlockedError,
  HarvestPlanRequiredError,
  RestoreUniquenessConflictError,
  TankCapacityExceededError,
} from '../farm-errors';
import { FarmAppError } from '../farm-app-error';
import { FarmAppErrorFilter } from '../farm-app-error.filter';

function makeGqlHost(params: {
  correlationId?: string;
}): ArgumentsHost {
  return {
    getType: () => 'graphql' as GqlContextType,
    getArgs: () => [
      undefined,
      undefined,
      {
        req: {
          headers: params.correlationId
            ? { 'x-correlation-id': params.correlationId }
            : {},
        },
      },
      {},
    ],
    // The remaining switchTo* methods are not called by the filter.
  } as unknown as ArgumentsHost;
}

function makeHttpHost(): ArgumentsHost {
  return {
    getType: () => 'http',
  } as unknown as ArgumentsHost;
}

describe('FarmAppError subclasses', () => {
  it('BatchWithdrawalBlockedError carries the stable code + activeTreatments', () => {
    const err = new BatchWithdrawalBlockedError({
      userMessage: 'Active withdrawal blocks close.',
      activeTreatments: [
        {
          eventCode: 'HE-0001',
          productName: 'Florfenicol',
          earliestHarvestDate: '2026-05-01',
          daysRemaining: 3,
        },
      ],
      fieldPath: ['closeBatch', 'id'],
    });
    expect(err).toBeInstanceOf(FarmAppError);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.code).toBe('BATCH_WITHDRAWAL_BLOCKED');
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.fieldPath).toEqual(['closeBatch', 'id']);
    expect(err.context).toEqual({
      activeTreatments: [
        {
          eventCode: 'HE-0001',
          productName: 'Florfenicol',
          earliestHarvestDate: '2026-05-01',
          daysRemaining: 3,
        },
      ],
    });
  });

  it('TankCapacityExceededError exposes axis + thresholds', () => {
    const err = new TankCapacityExceededError({
      userMessage: 'Capacity exceeded',
      axis: 'biomass',
      mode: 'hard',
      projectedBiomassKg: 1200,
      maxBiomassKg: 1000,
    });
    expect(err.code).toBe('TANK_CAPACITY_EXCEEDED');
    expect(err.context).toMatchObject({
      axis: 'biomass',
      mode: 'hard',
      projectedBiomassKg: 1200,
      maxBiomassKg: 1000,
    });
  });

  it('BackdateBlockedError exposes context + limitDays', () => {
    const err = new BackdateBlockedError({
      userMessage: 'Too old',
      backdateContext: 'feeding',
      proposedDate: '2025-12-31T00:00:00Z',
      limitDays: 7,
      backdatedDays: 120,
    });
    expect(err.code).toBe('BACKDATE_BLOCKED');
    expect(err.context).toMatchObject({
      context: 'feeding',
      limitDays: 7,
      backdatedDays: 120,
    });
  });

  it('RestoreUniquenessConflictError is 409 + conflictingKeys', () => {
    const err = new RestoreUniquenessConflictError({
      userMessage: 'Code collision',
      entityType: 'Feed',
      entityId: 'feed-1',
      conflictingKeys: ['code'],
    });
    expect(err.code).toBe('RESTORE_UNIQUENESS_CONFLICT');
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.context).toMatchObject({
      entityType: 'Feed',
      entityId: 'feed-1',
      conflictingKeys: ['code'],
    });
  });

  it('HarvestPlanRequiredError carries threshold values', () => {
    const err = new HarvestPlanRequiredError({
      userMessage: 'Plan required',
      batchId: 'batch-1',
      projectedBiomassKg: 15000,
      thresholdBiomassKg: 10000,
      projectedQuantity: 60000,
      thresholdQuantity: 50000,
    });
    expect(err.code).toBe('HARVEST_PLAN_REQUIRED');
    expect(err.context).toMatchObject({
      batchId: 'batch-1',
      projectedBiomassKg: 15000,
      thresholdBiomassKg: 10000,
    });
  });
});

describe('FarmAppErrorFilter', () => {
  it('produces a GraphQLError with the documented extensions envelope', () => {
    const filter = new FarmAppErrorFilter();
    const err = new BatchWithdrawalBlockedError({
      userMessage: 'Active withdrawal',
      activeTreatments: [
        {
          eventCode: 'HE-1',
          productName: 'X',
          earliestHarvestDate: '2026-05-01',
          daysRemaining: 2,
        },
      ],
      fieldPath: ['closeBatch', 'id'],
    });
    const out = filter.catch(err, makeGqlHost({ correlationId: 'corr-123' }));
    expect(out).toBeInstanceOf(GraphQLError);
    expect(out.message).toBe('Active withdrawal');
    expect(out.extensions?.code).toBe('BATCH_WITHDRAWAL_BLOCKED');
    expect(out.extensions?.userMessage).toBe('Active withdrawal');
    expect(out.extensions?.fieldPath).toEqual(['closeBatch', 'id']);
    expect(out.extensions?.retryable).toBe(false);
    expect(out.extensions?.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(out.extensions?.correlationId).toBe('corr-123');
    expect(out.extensions?.context).toEqual({
      activeTreatments: [
        {
          eventCode: 'HE-1',
          productName: 'X',
          earliestHarvestDate: '2026-05-01',
          daysRemaining: 2,
        },
      ],
    });
  });

  it('omits correlationId when the header is missing', () => {
    const filter = new FarmAppErrorFilter();
    const err = new BackdateBlockedError({
      userMessage: 'Too old',
      backdateContext: 'feeding',
    });
    const out = filter.catch(err, makeGqlHost({}));
    expect(out.extensions?.correlationId).toBeUndefined();
  });

  it('re-throws for non-graphql context so HTTP chain is preserved', () => {
    const filter = new FarmAppErrorFilter();
    const err = new TankCapacityExceededError({
      userMessage: 'Exceeded',
      axis: 'density',
      mode: 'hard',
    });
    expect(() => filter.catch(err, makeHttpHost())).toThrow(err);
  });
});
