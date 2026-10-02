/**
 * HarvestPlanService.completeHarvest moves real stock (FARM-HIGH-359).
 *
 * Completing a plan used to write only the plan's own "actual" fields, so the
 * batch quantity and the tank stock never moved. Completion now issues the
 * stock-movement SSoT command (CreateHarvestRecordCommand) for every live
 * TankBatch location of the plan's batch, split in proportion to the stock in
 * each tank, BEFORE the plan is marked COMPLETED (the command rejects a
 * completed plan).
 */
import { BadRequestException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import { collaborator, stubMember } from '@aquaculture/testing';
import type { CommandBus } from '@platform/cqrs';
import type { Repository } from 'typeorm';

import type { TankAllocation } from '../../batch/entities/tank-allocation.entity';
import { TankBatch, type BatchDetail } from '../../batch/entities/tank-batch.entity';
import type { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';
import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { HarvestPlanService } from '../services/harvest-plan.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_BATCH_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const SITE_ID = '66666666-6666-4666-8666-666666666666';

function detail(batchId: string, quantity: number): BatchDetail {
  return {
    batchId,
    batchNumber: `B-${quantity}`,
    quantity,
    avgWeightG: 50,
    biomassKg: (quantity * 50) / 1000,
    percentageOfTank: 100,
  };
}

function tankBatch(tankId: string, details: BatchDetail[]): TankBatch {
  return Object.assign(new TankBatch(), {
    tenantId: TENANT_ID,
    tankId,
    batchDetails: details,
    totalQuantity: details.reduce((sum, d) => sum + d.quantity, 0),
  });
}

function harness(status: HarvestPlanStatus, tankBatches: TankBatch[]) {
  const plan = Object.assign(new HarvestPlan(), {
    id: PLAN_ID,
    tenantId: TENANT_ID,
    planCode: 'HP-2026-00001',
    batchId: BATCH_ID,
    status,
  });
  const events: string[] = [];
  const execute = jest.fn((command: unknown) => {
    events.push(`command:${plan.status}`);
    return Promise.resolve(command);
  });
  const save = jest.fn((saved: HarvestPlan) => {
    events.push(`save:${saved.status}`);
    return Promise.resolve(saved);
  });
  const service = new HarvestPlanService(
    collaborator<Repository<HarvestPlan>>(
      {
        findOne: stubMember<Repository<HarvestPlan>['findOne']>(() => Promise.resolve(plan)),
        save: stubMember<Repository<HarvestPlan>['save']>(save),
      },
      'HarvestPlanRepository',
    ),
    collaborator<Repository<TankAllocation>>({}, 'TankAllocationRepository'),
    collaborator<Repository<TankBatch>>(
      { find: stubMember<Repository<TankBatch>['find']>(() => Promise.resolve(tankBatches)) },
      'TankBatchRepository',
    ),
    collaborator<BatchHarvestEligibilityService>({}, 'BatchHarvestEligibilityService'),
    collaborator<CommandBus>({ execute: stubMember<CommandBus['execute']>(execute) }, 'CommandBus'),
  );
  return { service, plan, execute, save, events };
}

function issuedCommands(execute: jest.Mock): CreateHarvestRecordCommand[] {
  return execute.mock.calls.map(([command]: unknown[]) => {
    if (!(command instanceof CreateHarvestRecordCommand)) {
      throw new Error('completeHarvest issued an unexpected command');
    }
    return command;
  });
}

describe('HarvestPlanService.completeHarvest — stock movement', () => {
  it('issues one harvest record per stocked tank, proportional, before completing the plan', async () => {
    const { service, plan, execute, events } = harness(HarvestPlanStatus.IN_PROGRESS, [
      tankBatch('tank-a', [detail(BATCH_ID, 600)]),
      tankBatch('tank-b', [detail(BATCH_ID, 200), detail(OTHER_BATCH_ID, 999)]),
      tankBatch('tank-c', [detail(OTHER_BATCH_ID, 500)]),
    ]);

    const result = await service.completeHarvest(
      TENANT_ID,
      PLAN_ID,
      400,
      20,
      50,
      USER_ID,
      [Role.MODULE_MANAGER],
      [SITE_ID],
    );

    const commands = issuedCommands(execute);
    expect(commands.map((c) => [c.input.tankId, c.input.quantityHarvested])).toEqual([
      ['tank-a', 300],
      ['tank-b', 100],
    ]);
    for (const command of commands) {
      expect(command.tenantId).toBe(TENANT_ID);
      expect(command.input.batchId).toBe(BATCH_ID);
      expect(command.input.harvestPlanId).toBe(PLAN_ID);
      expect(command.recordedBy).toBe(USER_ID);
      expect(command.userRoles).toEqual([Role.MODULE_MANAGER]);
      expect(command.callerAssignedSiteIds).toEqual([SITE_ID]);
    }
    // Stock moves while the plan is still IN_PROGRESS; COMPLETED is saved last.
    expect(events).toEqual([
      `command:${HarvestPlanStatus.IN_PROGRESS}`,
      `command:${HarvestPlanStatus.IN_PROGRESS}`,
      `save:${HarvestPlanStatus.COMPLETED}`,
    ]);
    expect(result).toBe(plan);
    expect(plan.actualQuantityHarvested).toBe(400);
  });

  it('never harvests more than the stock that exists', async () => {
    const { service, execute } = harness(HarvestPlanStatus.IN_PROGRESS, [
      tankBatch('tank-a', [detail(BATCH_ID, 150)]),
    ]);

    await service.completeHarvest(
      TENANT_ID,
      PLAN_ID,
      400,
      20,
      50,
      USER_ID,
      [Role.TENANT_ADMIN],
      [],
    );

    expect(issuedCommands(execute).map((c) => c.input.quantityHarvested)).toEqual([150]);
  });

  it('completes the plan without a command when the batch has no stocked location', async () => {
    const { service, execute, save } = harness(HarvestPlanStatus.IN_PROGRESS, [
      tankBatch('tank-c', [detail(OTHER_BATCH_ID, 500)]),
    ]);

    const result = await service.completeHarvest(TENANT_ID, PLAN_ID, 400, 20, 50, USER_ID);

    expect(execute).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(HarvestPlanStatus.COMPLETED);
  });

  it('refuses a plan that is not in progress and moves no stock', async () => {
    const { service, execute, save } = harness(HarvestPlanStatus.SCHEDULED, [
      tankBatch('tank-a', [detail(BATCH_ID, 600)]),
    ]);

    await expect(service.completeHarvest(TENANT_ID, PLAN_ID, 400, 20, 50, USER_ID)).rejects.toThrow(
      BadRequestException,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
