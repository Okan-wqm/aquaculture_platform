/**
 * Get Equipment Delete Preview Handler
 * Gathers all items that will be affected by equipment deletion
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { GetEquipmentDeletePreviewQuery } from '../queries/get-equipment-delete-preview.query';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';
import {
  EquipmentDeletePreviewResponse,
  EquipmentChildSummary,
  SubEquipmentSummary,
} from '../dto/equipment-delete-preview.response';

@QueryHandler(GetEquipmentDeletePreviewQuery)
export class GetEquipmentDeletePreviewHandler
  implements IQueryHandler<GetEquipmentDeletePreviewQuery, EquipmentDeletePreviewResponse>
{
  private readonly logger = new Logger(GetEquipmentDeletePreviewHandler.name);

  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
  ) {}

  async execute(
    query: GetEquipmentDeletePreviewQuery,
  ): Promise<EquipmentDeletePreviewResponse> {
    const { equipmentId, tenantId } = query;

    this.logger.log(`Getting delete preview for equipment: ${equipmentId}`);

    // Find the equipment
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId, isDeleted: false },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
    }

    // Get all child equipment recursively
    const childEquipment = await this.getChildEquipmentRecursive(equipmentId, tenantId);

    // Get all sub-equipment
    const subEquipment = await this.subEquipmentRepository.find({
      where: { parentEquipmentId: equipmentId, tenantId },
    });

    // No blockers for equipment deletion
    const blockers: string[] = [];

    // Build child equipment summaries
    const childEquipmentSummaries: EquipmentChildSummary[] = childEquipment.map((eq) => ({
      id: eq.id,
      name: eq.name,
      code: eq.code,
      status: eq.status,
    }));

    // Build sub-equipment summaries
    const subEquipmentSummaries: SubEquipmentSummary[] = subEquipment.map((se) => ({
      id: se.id,
      name: se.name,
      code: se.code,
      status: se.status,
    }));

    // Calculate total count
    const totalCount = childEquipment.length + subEquipment.length;

    return {
      equipment: equipment as any,
      canDelete: blockers.length === 0,
      blockers,
      affectedItems: {
        childEquipment: childEquipmentSummaries,
        subEquipment: subEquipmentSummaries,
        totalCount,
      },
    };
  }

  /**
   * Recursively get all child equipment
   */
  private async getChildEquipmentRecursive(
    parentId: string,
    tenantId: string,
  ): Promise<Equipment[]> {
    const children = await this.equipmentRepository.find({
      where: { parentEquipmentId: parentId, tenantId, isDeleted: false },
    });

    let allChildren = [...children];

    for (const child of children) {
      const grandChildren = await this.getChildEquipmentRecursive(child.id, tenantId);
      allChildren = [...allChildren, ...grandChildren];
    }

    return allChildren;
  }
}
