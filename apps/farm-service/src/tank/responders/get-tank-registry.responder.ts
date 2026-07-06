import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { runInTenantRead, isValidUUID } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';
import { Tank } from '../entities/tank.entity';

/**
 * Live farm read over NATS request-reply (Faz 3a). ai-service farm read tools
 * publish request.farm.getTankRegistry to give the assistant the tenant's real
 * tank list. The read runs through runInTenantRead — the fully-sanctioned,
 * RLS-safe tenant-context SSoT (tenantId-keyed).
 *
 * NOTE: messaging-service's KnowledgeExtractionService also targets this subject
 * but sends {tenantSchema} (a lossy tenant_<16hex> it cannot map back to a
 * tenantId). Wiring that caller needs a schema-direct read helper on the
 * tenant-isolation surface — tracked as a follow-up (docs/reviews/orphan-findings.md);
 * this responder validates the payload and answers empty for a non-UUID rather
 * than crashing, so the still-unwired caller degrades exactly as before.
 */
export interface GetTankRegistryRequest {
  tenantId: string;
}

export interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
  status: string;
}

@Controller()
export class GetTankRegistryResponder {
  private readonly logger = new Logger(GetTankRegistryResponder.name);

  constructor(private readonly dataSource: DataSource) {}

  @MessagePattern('request.farm.getTankRegistry')
  async handleGetTankRegistry(
    @Payload() payload: GetTankRegistryRequest,
  ): Promise<TankRegistryEntry[]> {
    if (!payload?.tenantId || !isValidUUID(payload.tenantId)) {
      // Fail-safe: an unwired/malformed caller gets an empty registry, never an
      // exception that would poison the request-reply channel.
      return [];
    }

    try {
      return await runInTenantRead(this.dataSource, 'farm', payload.tenantId, async (qr) => {
        const tanks = await qr.manager.find(Tank, {
          select: { id: true, code: true, name: true, status: true },
          order: { code: 'ASC' },
        });
        return tanks.map((t) => ({ id: t.id, code: t.code, name: t.name, status: t.status }));
      });
    } catch (err) {
      this.logger.error(
        `request.farm.getTankRegistry failed for tenant ${payload.tenantId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return [];
    }
  }
}
