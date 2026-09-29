import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isTankCapacityRequest,
  type TenantBoundReply,
  type TankCapacityReply,
} from '@platform/event-contracts';
import { GetTankCapacityQuery, type TankCapacityResult } from '../queries/get-tank-capacity.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

export function projectCapacity(result: TankCapacityResult): TankCapacityReply {
  return {
    tankId: result.tankId,
    tankCode: result.tankCode,
    tankName: result.tankName,
    volumeM3: result.volumeM3,
    maxCapacityKg: result.maxCapacityKg,
    maxDensityKgM3: result.maxDensityKgM3,
    optimalDensityMinKgM3: result.optimalDensityMinKgM3,
    optimalDensityMaxKgM3: result.optimalDensityMaxKgM3,
    currentQuantity: result.currentQuantity,
    currentBiomassKg: result.currentBiomassKg,
    currentDensityKgM3: result.currentDensityKgM3,
    currentAvgWeightG: result.currentAvgWeightG,
    capacityUsedKg: result.capacityUsedKg,
    capacityAvailableKg: result.capacityAvailableKg,
    capacityUsedPct: result.capacityUsedPercent,
    densityStatus: result.densityStatus,
    capacityStatus: result.capacityStatus,
    batchCount: result.batchCount,
    primaryBatchId: result.primaryBatchId ?? null,
    primaryBatchNumber: result.primaryBatchNumber ?? null,
    warnings: [...result.warnings],
  };
}

/** Tank capacity for the production and operations specialists (FARM-MEDIUM-328). */
@Controller()
export class TankAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY)
  getCapacity(@Payload() payload: unknown): Promise<TenantBoundReply<TankCapacityReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY,
        isRequest: isTankCapacityRequest,
        handle: async (req, scope) => {
          const result = await this.queryBus.execute<GetTankCapacityQuery, TankCapacityResult>(
            new GetTankCapacityQuery(scope, req.tankId),
          );
          return projectCapacity(result);
        },
      },
      payload,
    );
  }
}
