import { Controller, ForbiddenException } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import {
  getTenantSchemaName,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { UUID_REGEX } from '@aquaculture/backend-common/constants';

import { Tank } from '../entities/tank.entity';

interface TankRegistryRequest {
  tenantId: string;
  tenantSchema?: string;
}

interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
}

@Controller()
export class TankRegistryNatsHandler {
  constructor(private readonly dataSource: DataSource) {}

  @MessagePattern('request.farm.getTankRegistry')
  async getTankRegistry(
    @Payload() payload: TankRegistryRequest,
  ): Promise<TankRegistryEntry[]> {
    const { tenantId, tenantSchema } = payload;
    if (!UUID_REGEX.test(tenantId)) {
      throw new ForbiddenException('Invalid tenantId');
    }

    if (tenantSchema && tenantSchema !== getTenantSchemaName(tenantId)) {
      throw new ForbiddenException('Tenant schema does not match tenantId');
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const tanks = await queryRunner.manager.find(Tank, {
        where: { tenantId, isActive: true },
        select: ['id', 'code', 'name'],
        order: { code: 'ASC' },
      });
      return tanks.map((tank) => ({
        id: tank.id,
        code: tank.code,
        name: tank.name,
      }));
    });
  }
}
