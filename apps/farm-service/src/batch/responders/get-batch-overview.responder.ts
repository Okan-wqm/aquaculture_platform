import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { isAiQueryRequestShape, type TenantBoundReply } from '@platform/event-contracts';
import { Batch } from '../entities/batch.entity';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/**
 * Live batch overview over NATS request-reply (Faz 3a). ai-service's
 * get_farm_batches read tool publishes request.farm.getBatchOverview so the
 * assistant can ground answers about a batch (e.g. "what is the status of
 * B-2024-001?") in real data. Reads on the TenantScope the
 * responder skeleton (FarmAiResponder) opened — tenant schema + RLS pinned. Detailed
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
  constructor(private readonly responder: FarmAiResponder) {}

  // K10 (MT-HIGH-062): one responder skeleton — guard, tenant frame, and a
  // reply that names the tenant it served. A failure is an INTERNAL_ERROR the
  // ai-service tool surfaces, not an empty list the model reads as "no data".
  @MessagePattern('request.farm.getBatchOverview')
  handleGetBatchOverview(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<BatchOverviewEntry[]>> {
    return this.responder.respond(
      {
        subject: 'request.farm.getBatchOverview',
        isRequest: isGetBatchOverviewRequest,
        handle: async (_request, scope) => {
          const batches = await scope.manager.find(Batch, {
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
        },
      },
      payload,
    );
  }
}
