import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { respondTenantBound } from '@aquaculture/backend-common/nats';
import { isAiQueryRequestShape, type TenantBoundReply } from '@platform/event-contracts';
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

/** Contract guard: exactly `{ tenantId }` with a UUID tenant. */
function isGetFeedingOverviewRequest(value: unknown): value is GetFeedingOverviewRequest {
  return isAiQueryRequestShape(value, []);
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

  // K10 (MT-HIGH-062): one responder skeleton — guard, tenant frame, and a
  // reply that names the tenant it served. A failure is an INTERNAL_ERROR the
  // ai-service tool surfaces, not an empty list the model reads as "no data".
  @MessagePattern('request.farm.getFeedingOverview')
  handleGetFeedingOverview(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<FeedingRecordEntry[]>> {
    return respondTenantBound(
      this.logger,
      'request.farm.getFeedingOverview',
      payload,
      isGetFeedingOverviewRequest,
      (request) =>
        runInTenantRead(this.dataSource, 'farm', request.tenantId, async (qr) => {
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
        }),
    );
  }
}
