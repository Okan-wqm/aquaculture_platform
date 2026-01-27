/**
 * Get System Delete Preview Handler
 * Gathers all items that will be affected by system deletion
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(EquipmentSystem)
    private readonly equipmentSystemRepository: Repository<EquipmentSystem>,
  ) {}

  async execute(
    query: GetSystemDeletePreviewQuery,
  ): Promise<SystemDeletePreviewResponse> {
    const { systemId, tenantId } = query;

    this.logger.log(`Getting delete preview for system: ${systemId}`);

    // Find the system
    const system = await this.systemRepository.findOne({
      where: { id: systemId, tenantId, isDeleted: false },
    });

    if (!system) {
      throw new NotFoundException(`System with ID "${systemId}" not found`);
    }

    // Get all child systems recursively
    const childSystems = await this.getChildSystemsRecursive(systemId, tenantId);

    // Get all equipment connected to this system and child systems
    const systemIds = [systemId, ...childSystems.map((s) => s.id)];
    const equipmentSystems = await this.equipmentSystemRepository
      .createQueryBuilder('es')
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
      system: system as unknown as SystemResponse,
      canDelete: blockers.length === 0,
      blockers,
      affectedItems: {
        childSystems: childSystemSummaries,
        equipment: equipmentSummaries,
        totalCount,
      },
    };
  }

  /**
   * Recursively get all child systems
   */
  private async getChildSystemsRecursive(
    parentId: string,
    tenantId: string,
  ): Promise<System[]> {
    const children = await this.systemRepository.find({
      where: { parentSystemId: parentId, tenantId, isDeleted: false },
    });

    let allChildren = [...children];

    for (const child of children) {
      const grandChildren = await this.getChildSystemsRecursive(child.id, tenantId);
      allChildren = [...allChildren, ...grandChildren];
    }

    return allChildren;
  }
}
