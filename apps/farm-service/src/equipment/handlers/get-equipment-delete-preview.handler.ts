/**
 * Get Equipment Delete Preview Handler
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { NotFoundException, Logger } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';

import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import {
  EquipmentDeletePreviewResponse,
  EquipmentChildSummary,
  SubEquipmentSummary,
} from '../dto/equipment-delete-preview.response';
import { EquipmentResponse } from '../dto/equipment.response';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { GetEquipmentDeletePreviewQuery } from '../queries/get-equipment-delete-preview.query';
import { TankEquipmentAdapterService } from '../services/tank-equipment-adapter.service';

@QueryHandler(GetEquipmentDeletePreviewQuery)
export class GetEquipmentDeletePreviewHandler
  implements IQueryHandler<GetEquipmentDeletePreviewQuery, EquipmentDeletePreviewResponse>
{
  private readonly logger = new Logger(GetEquipmentDeletePreviewHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tankEquipmentAdapter: TankEquipmentAdapterService,
  ) {}

  async execute(query: GetEquipmentDeletePreviewQuery): Promise<EquipmentDeletePreviewResponse> {
    const { equipmentId, tenantId } = query;

    this.logger.log(`Getting delete preview for equipment: ${equipmentId}`);

    const equipmentRepository = tenantManagerRepo(this.dataSource.manager, Equipment, tenantId);
    const subEquipmentRepository = tenantManagerRepo(this.dataSource.manager, SubEquipment, tenantId);
    const tankRepository = tenantManagerRepo(this.dataSource.manager, Tank, tenantId);

    const equipment = await equipmentRepository.findOne({
      where: { id: equipmentId, tenantId, isDeleted: false },
    });

    if (!equipment) {
      const tank = await tankRepository.findOne({
        where: { id: equipmentId, tenantId },
      });
      if (!tank) {
        throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
      }
      return this.previewTankDelete(tank, tenantId);
    }

    const childEquipment = await this.getChildEquipmentRecursive(equipmentId, tenantId);
    const subEquipment = await subEquipmentRepository.find({
      where: { parentEquipmentId: equipmentId, tenantId, isActive: true },
    });

    const blockers: string[] = [];
    const childEquipmentSummaries: EquipmentChildSummary[] = childEquipment.map((eq) => ({
      id: eq.id,
      name: eq.name,
      code: eq.code,
      status: eq.status,
    }));
    const subEquipmentSummaries: SubEquipmentSummary[] = subEquipment.map((se) => ({
      id: se.id,
      name: se.name,
      code: se.code,
      status: se.status,
    }));

    return {
      equipment: equipment as EquipmentResponse,
      canDelete: blockers.length === 0,
      blockers,
      affectedItems: {
        childEquipment: childEquipmentSummaries,
        subEquipment: subEquipmentSummaries,
        totalCount: childEquipment.length + subEquipment.length,
      },
    };
  }

  private async previewTankDelete(tank: Tank, tenantId: string): Promise<EquipmentDeletePreviewResponse> {
    const tankBatchRepository = tenantManagerRepo(this.dataSource.manager, TankBatch, tenantId);
    const tankBatches = await tankBatchRepository.find({
      where: { tankId: tank.id, tenantId },
    });
    const blockers: string[] = [];
    if (Number(tank.currentBiomass || 0) > 0) {
      blockers.push(`Tank has ${tank.currentBiomass}kg of active biomass`);
    }
    const activeBatchCount = tankBatches.filter(
      (batch) =>
        Number(batch.totalQuantity || 0) > 0 ||
        Number(batch.totalBiomassKg || 0) > 0 ||
        Number(batch.cleanerFishQuantity || 0) > 0 ||
        Number(batch.cleanerFishBiomassKg || 0) > 0,
    ).length;
    if (activeBatchCount > 0) {
      blockers.push(`Tank has ${activeBatchCount} active batch allocation(s)`);
    }
    const equipmentType = await this.tankEquipmentAdapter.resolveEquipmentTypeForTank(tank);
    return {
      equipment: this.tankEquipmentAdapter.toEquipmentResponse(tank, equipmentType) as EquipmentResponse,
      canDelete: blockers.length === 0,
      blockers,
      affectedItems: {
        childEquipment: [],
        subEquipment: [],
        totalCount: 0,
      },
    };
  }

  private async getChildEquipmentRecursive(
    parentId: string,
    tenantId: string,
    maxDepth = 10,
  ): Promise<Equipment[]> {
    const allChildren: Equipment[] = [];
    let currentParentIds = [parentId];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < maxDepth) {
      const equipmentRepository = tenantManagerRepo(this.dataSource.manager, Equipment, tenantId);
      const children = await equipmentRepository.find({
        where: {
          parentEquipmentId: In(currentParentIds),
          tenantId,
          isDeleted: false,
        },
      });
      if (children.length === 0) break;
      allChildren.push(...children);
      currentParentIds = children.map((child) => child.id);
      depth++;
    }

    if (depth >= maxDepth) {
      this.logger.warn(
        `Max depth (${maxDepth}) reached while fetching child equipment for parent ${parentId}`,
      );
    }

    return allChildren;
  }
}
