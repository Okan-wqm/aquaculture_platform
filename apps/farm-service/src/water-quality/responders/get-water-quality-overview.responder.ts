import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead, isValidUUID } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';

/** Bound so a large history cannot flood the agent turn / the reply payload. */
const RECENT_MEASUREMENTS_LIMIT = 25;

/**
 * Recent water-quality readings over NATS request-reply (Faz 3a). ai-service's
 * get_farm_water_quality read tool publishes request.farm.getWaterQualityOverview
 * so the assistant can ground answers about a tank's water in real data ("what
 * is tank X's dissolved oxygen right now?"). Reads through runInTenantRead — the
 * fully-sanctioned, RLS-safe tenant-context SSoT — and returns the most recent
 * measurements (newest first, capped); the assistant filters by tank.
 */
export interface GetWaterQualityRequest {
  tenantId: string;
}

export interface WaterQualityReading {
  id: string;
  tankId: string | null;
  pondId: string | null;
  measuredAt: string;
  temperature: number | null;
  dissolvedOxygen: number | null;
  pH: number | null;
  ammonia: number | null;
  nitrite: number | null;
}

@Controller()
export class GetWaterQualityOverviewResponder {
  private readonly logger = new Logger(GetWaterQualityOverviewResponder.name);

  constructor(private readonly dataSource: DataSource) {}

  @MessagePattern('request.farm.getWaterQualityOverview')
  async handleGetWaterQualityOverview(
    @Payload() payload: GetWaterQualityRequest,
  ): Promise<WaterQualityReading[]> {
    if (!payload?.tenantId || !isValidUUID(payload.tenantId)) {
      return [];
    }

    try {
      return await runInTenantRead(this.dataSource, 'farm', payload.tenantId, async (qr) => {
        const rows = await qr.manager.find(WaterQualityMeasurement, {
          select: {
            id: true,
            tankId: true,
            pondId: true,
            measuredAt: true,
            temperature: true,
            dissolvedOxygen: true,
            pH: true,
            ammonia: true,
            nitrite: true,
          },
          order: { measuredAt: 'DESC' },
          take: RECENT_MEASUREMENTS_LIMIT,
        });
        return rows.map((r) => ({
          id: r.id,
          tankId: r.tankId ?? null,
          pondId: r.pondId ?? null,
          measuredAt: r.measuredAt.toISOString(),
          temperature: r.temperature ?? null,
          dissolvedOxygen: r.dissolvedOxygen ?? null,
          pH: r.pH ?? null,
          ammonia: r.ammonia ?? null,
          nitrite: r.nitrite ?? null,
        }));
      });
    } catch (err) {
      this.logger.error(
        `request.farm.getWaterQualityOverview failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}
