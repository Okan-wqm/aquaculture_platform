import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead, isValidUUID } from '@aquaculture/backend-common/database';
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

  @MessagePattern('request.farm.getBatchOverview')
  async handleGetBatchOverview(
    @Payload() payload: GetBatchOverviewRequest,
  ): Promise<BatchOverviewEntry[]> {
    if (!payload?.tenantId || !isValidUUID(payload.tenantId)) {
      // Fail-safe: an unwired/malformed caller gets an empty overview, never an
      // exception that would poison the request-reply channel.
      return [];
    }

    try {
      return await runInTenantRead(this.dataSource, 'farm', payload.tenantId, async (qr) => {
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
      });
    } catch (err) {
      this.logger.error(
        `request.farm.getBatchOverview failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}
