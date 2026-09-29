import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { isAiQueryRequestShape, type TenantBoundReply } from '@platform/event-contracts';
import { Tank } from '../entities/tank.entity';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/**
 * Live farm read over NATS request-reply (Faz 3a). ai-service farm read tools
 * publish request.farm.getTankRegistry to give the assistant the tenant's real
 * tank list. The read runs through runInTenantRead — the fully-sanctioned,
 * RLS-safe tenant-context SSoT (tenantId-keyed).
 *
 * Callers: ai-service's get_farm_tanks tool (TenantBoundNatsClient injects
 * the tenant) and messaging's KnowledgeExtractionService, which takes the UUID
 * from the verified tenant-schema ledger rather than from the lossy
 * tenant_<16hex> schema name (ORPHAN-MEDIUM-336, resolved). The responder
 * remains tenantId-keyed by design: the UUID is the canonical tenant key and
 * lets runInTenantRead assert the RLS GUC fail-closed. The reply is the
 * tenant-bound envelope (K10): a malformed payload is INVALID_REQUEST, a
 * failure INTERNAL_ERROR — never an exception into the request-reply channel.
 */
export interface GetTankRegistryRequest {
  tenantId: string;
}

/** Contract guard: exactly `{ tenantId }` with a UUID tenant. */
function isGetTankRegistryRequest(value: unknown): value is GetTankRegistryRequest {
  return isAiQueryRequestShape(value, []);
}

export interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
  status: string;
}

@Controller()
export class GetTankRegistryResponder {
  constructor(private readonly responder: FarmAiResponder) {}

  // K10 (MT-HIGH-062): one responder skeleton — guard, tenant frame, and a
  // reply that names the tenant it served. A failure is an INTERNAL_ERROR the
  // ai-service tool surfaces, not an empty list the model reads as "no data".
  @MessagePattern('request.farm.getTankRegistry')
  handleGetTankRegistry(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<TankRegistryEntry[]>> {
    return this.responder.respond(
      {
        subject: 'request.farm.getTankRegistry',
        isRequest: isGetTankRegistryRequest,
        handle: async (_request, scope) => {
          const tanks = await scope.manager.find(Tank, {
            select: { id: true, code: true, name: true, status: true },
            order: { code: 'ASC' },
          });
          return tanks.map((t) => ({ id: t.id, code: t.code, name: t.name, status: t.status }));
        },
      },
      payload,
    );
  }
}
