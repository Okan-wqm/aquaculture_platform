/**
 * Concrete domain error classes used across farm-service. Each
 * carries a stable `code` that the frontend branches on — the
 * CloseBatchModal already parses `BATCH_WITHDRAWAL_BLOCKED`; this
 * file formalises the contract and adds every rejection surface
 * that was previously returning a bare BadRequestException with
 * free-text `message`.
 *
 * Phase 6.4 of the "Farm modülü kalan kör noktalar" plan.
 */
import { HttpStatus } from '@nestjs/common';

import { FarmAppError } from './farm-app-error';

/**
 * Raised when an operator tries to close a batch or record a harvest
 * while a medicine-withdrawal period is still active. Frontend
 * renders the `context.activeTreatments` list so the operator can
 * either wait or explicitly acknowledge the override.
 */
export class BatchWithdrawalBlockedError extends FarmAppError {
  constructor(params: {
    userMessage: string;
    activeTreatments: Array<{
      eventCode: string;
      productName: string;
      earliestHarvestDate: string;
      daysRemaining: number;
    }>;
    fieldPath?: readonly string[];
  }) {
    super({
      code: 'BATCH_WITHDRAWAL_BLOCKED',
      status: HttpStatus.BAD_REQUEST,
      userMessage: params.userMessage,
      fieldPath: params.fieldPath,
      retryable: false,
      context: { activeTreatments: params.activeTreatments },
    });
  }
}

/**
 * Raised when TankCapacityService rejects an allocation because
 * biomass / density / status axis fails. Frontend can show the
 * specific failing axis in the projected-biomass preview.
 */
export class TankCapacityExceededError extends FarmAppError {
  constructor(params: {
    userMessage: string;
    axis: 'biomass' | 'density' | 'status';
    mode: 'hard' | 'admin_override' | 'soft';
    projectedBiomassKg?: number;
    maxBiomassKg?: number;
    projectedDensityKgM3?: number;
    maxDensityKgM3?: number;
    fieldPath?: readonly string[];
  }) {
    super({
      code: 'TANK_CAPACITY_EXCEEDED',
      status: HttpStatus.BAD_REQUEST,
      userMessage: params.userMessage,
      fieldPath: params.fieldPath,
      retryable: false,
      context: {
        axis: params.axis,
        mode: params.mode,
        projectedBiomassKg: params.projectedBiomassKg,
        maxBiomassKg: params.maxBiomassKg,
        projectedDensityKgM3: params.projectedDensityKgM3,
        maxDensityKgM3: params.maxDensityKgM3,
      },
    });
  }
}

/**
 * Raised when BackdatePolicyService rejects a proposed operational
 * date (future, beyond-limit, or non-Date). Frontend shows the
 * context + limit so operators can adjust the date-picker range.
 */
export class BackdateBlockedError extends FarmAppError {
  constructor(params: {
    userMessage: string;
    backdateContext: 'feeding' | 'growth' | 'mortality' | 'harvest';
    proposedDate?: string;
    limitDays?: number;
    backdatedDays?: number;
    fieldPath?: readonly string[];
  }) {
    super({
      code: 'BACKDATE_BLOCKED',
      status: HttpStatus.BAD_REQUEST,
      userMessage: params.userMessage,
      fieldPath: params.fieldPath,
      retryable: false,
      context: {
        context: params.backdateContext,
        proposedDate: params.proposedDate,
        limitDays: params.limitDays,
        backdatedDays: params.backdatedDays,
      },
    });
  }
}

/**
 * Raised when a restore mutation fails the active-row uniqueness
 * check. Frontend prompts the operator to resolve the conflicting
 * row (rename / merge / delete) before retrying.
 */
export class RestoreUniquenessConflictError extends FarmAppError {
  constructor(params: {
    userMessage: string;
    entityType: string;
    entityId: string;
    conflictingKeys: readonly string[];
    fieldPath?: readonly string[];
  }) {
    super({
      code: 'RESTORE_UNIQUENESS_CONFLICT',
      status: HttpStatus.CONFLICT,
      userMessage: params.userMessage,
      fieldPath: params.fieldPath,
      retryable: false,
      context: {
        entityType: params.entityType,
        entityId: params.entityId,
        conflictingKeys: params.conflictingKeys,
      },
    });
  }
}

/**
 * Raised when a large-biomass batch is harvested without an approved
 * harvest plan (phase 2.2).
 */
export class HarvestPlanRequiredError extends FarmAppError {
  constructor(params: {
    userMessage: string;
    batchId: string;
    projectedBiomassKg?: number;
    projectedQuantity?: number;
    thresholdBiomassKg: number;
    thresholdQuantity: number;
    fieldPath?: readonly string[];
  }) {
    super({
      code: 'HARVEST_PLAN_REQUIRED',
      status: HttpStatus.BAD_REQUEST,
      userMessage: params.userMessage,
      fieldPath: params.fieldPath,
      retryable: false,
      context: {
        batchId: params.batchId,
        projectedBiomassKg: params.projectedBiomassKg,
        projectedQuantity: params.projectedQuantity,
        thresholdBiomassKg: params.thresholdBiomassKg,
        thresholdQuantity: params.thresholdQuantity,
      },
    });
  }
}
