import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { isAiQueryRequestShape, type TenantBoundReply } from '@platform/event-contracts';
import { HarvestPlan } from '../entities/harvest-plan.entity';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

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

/** Contract guard: exactly `{ tenantId }` with a UUID tenant. */
function isGetHarvestOverviewRequest(value: unknown): value is GetHarvestOverviewRequest {
  return isAiQueryRequestShape(value, []);
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
  constructor(private readonly responder: FarmAiResponder) {}

  // K10 (MT-HIGH-062): one responder skeleton — guard, tenant frame, and a
  // reply that names the tenant it served. A failure is an INTERNAL_ERROR the
  // ai-service tool surfaces, not an empty list the model reads as "no data".
  @MessagePattern('request.farm.getHarvestOverview')
  handleGetHarvestOverview(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<HarvestPlanEntry[]>> {
    return this.responder.respond(
      {
        subject: 'request.farm.getHarvestOverview',
        isRequest: isGetHarvestOverviewRequest,
        handle: async (_request, scope) => {
          const plans = await scope.manager.find(HarvestPlan, {
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
        },
      },
      payload,
    );
  }
}
