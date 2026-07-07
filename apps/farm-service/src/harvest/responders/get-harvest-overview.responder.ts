import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead, isValidUUID } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';
import { HarvestPlan } from '../entities/harvest-plan.entity';

/**
 * Harvest-plan overview over NATS request-reply (Faz 3a). ai-service's
 * get_farm_harvest read tool publishes request.farm.getHarvestOverview so the
 * assistant can answer "what harvests are planned?" / "is B-2024-001 scheduled
 * to harvest?" from real data. Reads through runInTenantRead — the fully-
 * sanctioned, RLS-safe tenant-context SSoT — and returns plan identity + status
 * + planned date (soonest first).
 */
export interface GetHarvestOverviewRequest {
  tenantId: string;
}

export interface HarvestPlanEntry {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  plannedDate: string;
}

@Controller()
export class GetHarvestOverviewResponder {
  private readonly logger = new Logger(GetHarvestOverviewResponder.name);

  constructor(private readonly dataSource: DataSource) {}

  @MessagePattern('request.farm.getHarvestOverview')
  async handleGetHarvestOverview(
    @Payload() payload: GetHarvestOverviewRequest,
  ): Promise<HarvestPlanEntry[]> {
    if (!payload?.tenantId || !isValidUUID(payload.tenantId)) {
      return [];
    }

    try {
      return await runInTenantRead(this.dataSource, 'farm', payload.tenantId, async (qr) => {
        const plans = await qr.manager.find(HarvestPlan, {
          select: {
            id: true,
            planCode: true,
            name: true,
            batchId: true,
            status: true,
            plannedDate: true,
          },
          order: { plannedDate: 'ASC' },
        });
        return plans.map((p) => ({
          id: p.id,
          planCode: p.planCode,
          name: p.name,
          batchId: p.batchId,
          status: p.status,
          // `plannedDate` is a DATE column — normalise to YYYY-MM-DD whether the
          // driver hands back a Date or a string.
          plannedDate: new Date(p.plannedDate).toISOString().slice(0, 10),
        }));
      });
    } catch (err) {
      this.logger.error(
        `request.farm.getHarvestOverview failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}
