import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead, isValidUUID } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';
import { FeedingRecord } from '../entities/feeding-record.entity';

/** Bound so a large feeding history cannot flood the agent turn / the payload. */
const RECENT_FEEDINGS_LIMIT = 25;

/**
 * Recent feeding records over NATS request-reply (Faz 3a). ai-service's
 * get_farm_feeding read tool publishes request.farm.getFeedingOverview so the
 * assistant can answer "how much has batch B been fed recently?" from real
 * data. Reads through runInTenantRead — the fully-sanctioned, RLS-safe
 * tenant-context SSoT — and returns the most recent feedings (newest first,
 * capped); the assistant filters by batch/tank.
 */
export interface GetFeedingOverviewRequest {
  tenantId: string;
}

export interface FeedingRecordEntry {
  id: string;
  batchId: string;
  tankId: string | null;
  feedingDate: string;
  feedingTime: string;
  plannedAmountKg: number;
  actualAmountKg: number;
}

@Controller()
export class GetFeedingOverviewResponder {
  private readonly logger = new Logger(GetFeedingOverviewResponder.name);

  constructor(private readonly dataSource: DataSource) {}

  @MessagePattern('request.farm.getFeedingOverview')
  async handleGetFeedingOverview(
    @Payload() payload: GetFeedingOverviewRequest,
  ): Promise<FeedingRecordEntry[]> {
    if (!payload?.tenantId || !isValidUUID(payload.tenantId)) {
      return [];
    }

    try {
      return await runInTenantRead(this.dataSource, 'farm', payload.tenantId, async (qr) => {
        const rows = await qr.manager.find(FeedingRecord, {
          select: {
            id: true,
            batchId: true,
            tankId: true,
            feedingDate: true,
            feedingTime: true,
            plannedAmount: true,
            actualAmount: true,
          },
          order: { feedingDate: 'DESC', feedingTime: 'DESC' },
          take: RECENT_FEEDINGS_LIMIT,
        });
        return rows.map((r) => ({
          id: r.id,
          batchId: r.batchId,
          tankId: r.tankId ?? null,
          // `feedingDate` is a DATE column — normalise to YYYY-MM-DD.
          feedingDate: new Date(r.feedingDate).toISOString().slice(0, 10),
          feedingTime: r.feedingTime,
          plannedAmountKg: r.plannedAmount,
          actualAmountKg: r.actualAmount,
        }));
      });
    } catch (err) {
      this.logger.error(
        `request.farm.getFeedingOverview failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}
