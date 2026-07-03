/**
 * Get System Delete Preview Handler
 * Gathers all items that will be affected by system deletion
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { GetSystemDeletePreviewQuery } from '../queries/get-system-delete-preview.query';
import { System } from '../entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import {
  SystemDeletePreviewResponse,
  SystemChildSummary,
  SystemEquipmentSummary,
} from '../dto/system-delete-preview.response';
import { SystemResponse } from '../dto/system.response';

@QueryHandler(GetSystemDeletePreviewQuery)
export class GetSystemDeletePreviewHandler
  implements IQueryHandler<GetSystemDeletePreviewQuery, SystemDeletePreviewResponse>
{
  private readonly logger = new Logger(GetSystemDeletePreviewHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: GetSystemDeletePreviewQuery,
  ): Promise<SystemDeletePreviewResponse> {
    const { systemId, tenantId } = query;

    this.logger.log(`Getting delete preview for system: ${systemId}`);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Find the system
      const system = await queryRunner.manager.findOne(System, {
        where: { id: systemId, tenantId, isDeleted: false },
      });

      if (!system) {
        throw new NotFoundException(`System with ID "${systemId}" not found`);
      }

      // Get all child systems recursively
      const childSystems = await this.getChildSystemsRecursive(
        queryRunner.manager,
        systemId,
        tenantId,
      );

      // Get all equipment connected to this system and child systems
      const systemIds = [systemId, ...childSystems.map((s) => s.id)];
      const equipmentSystems = await queryRunner.manager
        .createQueryBuilder(EquipmentSystem, 'es')
        .leftJoinAndSelect('es.equipment', 'equipment')
        .where('es.systemId IN (:...systemIds)', { systemIds })
        .andWhere('es.tenantId = :tenantId', { tenantId })
        .andWhere('equipment.isDeleted = false')
        .getMany();

      // Get unique equipment
      const equipmentMap = new Map<string, Equipment>();
      for (const es of equipmentSystems) {
        if (es.equipment && !equipmentMap.has(es.equipment.id)) {
          equipmentMap.set(es.equipment.id, es.equipment);
        }
      }
      const equipment = Array.from(equipmentMap.values());

      // No blockers for system deletion (it just disconnects equipment)
      const blockers: string[] = [];

      // Build child system summaries
      const childSystemSummaries: SystemChildSummary[] = await Promise.all(
        childSystems.map(async (sys) => {
          const eqCount = equipmentSystems.filter((es) => es.systemId === sys.id).length;
          return {
            id: sys.id,
            name: sys.name,
            code: sys.code,
            equipmentCount: eqCount,
          };
        }),
      );

      // Build equipment summaries
      const equipmentSummaries: SystemEquipmentSummary[] = equipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        code: eq.code,
        status: eq.status,
      }));

      // Calculate total count
      const totalCount = childSystems.length + equipment.length;

      return {
        system: system as SystemResponse,
        canDelete: blockers.length === 0,
        blockers,
        affectedItems: {
          childSystems: childSystemSummaries,
          equipment: equipmentSummaries,
          totalCount,
        },
      };
    });
  }

  /**
   * Get all child systems using batch loading to avoid N+1 queries
   * Uses iterative breadth-first approach with depth limit
   */
  private async getChildSystemsRecursive(
    manager: EntityManager,
    parentId: string,
    tenantId: string,
    maxDepth: number = 10,
  ): Promise<System[]> {
    const allChildren: System[] = [];
    let currentParentIds = [parentId];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < maxDepth) {
      // Batch fetch all children for current level
      const children = await manager.find(System, {
        where: {
          parentSystemId: In(currentParentIds),
          tenantId,
          isDeleted: false,
        },
      });

      if (children.length === 0) {
        break;
      }

      allChildren.push(...children);
      currentParentIds = children.map((child) => child.id);
      depth++;
    }

    if (depth >= maxDepth) {
      this.logger.warn(
        `Max depth (${maxDepth}) reached while fetching child systems for parent ${parentId}`,
      );
    }

    return allChildren;
  }
}
