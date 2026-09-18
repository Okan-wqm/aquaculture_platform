import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isTankCapacityRequest,
  type AiQueryReply,
  type TankCapacityReply,
} from '@platform/event-contracts';
import { respondAiQuery } from '../../common/nats/ai-query-responder';
import { GetTankCapacityQuery, type TankCapacityResult } from '../queries/get-tank-capacity.query';

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
  private readonly logger = new Logger(TankAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY)
  getCapacity(@Payload() payload: unknown): Promise<AiQueryReply<TankCapacityReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY,
      payload,
      isTankCapacityRequest,
      async (req) => {
        const result = await this.queryBus.execute<GetTankCapacityQuery, TankCapacityResult>(
          new GetTankCapacityQuery(req.tenantId, req.tankId),
        );
        return projectCapacity(result);
      },
    );
  }
}
