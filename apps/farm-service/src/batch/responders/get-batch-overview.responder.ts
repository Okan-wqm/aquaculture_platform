import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { respondTenantBound } from '@aquaculture/backend-common/nats';
import { isAiQueryRequestShape, type TenantBoundReply } from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { Batch } from '../entities/batch.entity';

/**
 * Live batch overview over NATS request-reply (Faz 3a). ai-service's
 * get_farm_batches read tool publishes request.farm.getBatchOverview so the
 * assistant can ground answers about a batch (e.g. "what is the status of
 * B-2024-001?") in real data. Reads through runInTenantRead — the fully-
 * sanctioned, RLS-safe tenant-context SSoT (tenantId-keyed). Detailed
 * count/biomass live in the batchDetails SSoT (an aggregation) and are left to a
 * richer follow-up tool; this returns batch identity + lifecycle status.
 */
export interface GetBatchOverviewRequest {
  tenantId: string;
}

/** Contract guard: exactly `{ tenantId }` with a UUID tenant. */
function isGetBatchOverviewRequest(value: unknown): value is GetBatchOverviewRequest {
  return isAiQueryRequestShape(value, []);
}

export interface BatchOverviewEntry {
  id: string;
  batchNumber: string;
  name: string | null;
  status: string;
  statusChangedAt: string | null;
}

@Controller()
export class GetBatchOverviewResponder {
  private readonly logger = new Logger(GetBatchOverviewResponder.name);

  constructor(private readonly dataSource: DataSource) {}

  // K10 (MT-HIGH-062): one responder skeleton — guard, tenant frame, and a
  // reply that names the tenant it served. A failure is an INTERNAL_ERROR the
  // ai-service tool surfaces, not an empty list the model reads as "no data".
  @MessagePattern('request.farm.getBatchOverview')
  handleGetBatchOverview(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<BatchOverviewEntry[]>> {
    return respondTenantBound(
      this.logger,
      'request.farm.getBatchOverview',
      payload,
      isGetBatchOverviewRequest,
      (request) =>
        runInTenantRead(this.dataSource, 'farm', request.tenantId, async (qr) => {
          const batches = await qr.manager.find(Batch, {
            select: {
              id: true,
              batchNumber: true,
              name: true,
              status: true,
              statusChangedAt: true,
            },
            order: { batchNumber: 'ASC' },
          });
          return batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            name: b.name ?? null,
            status: b.status,
            statusChangedAt: b.statusChangedAt ? b.statusChangedAt.toISOString() : null,
          }));
        }),
    );
  }
}
