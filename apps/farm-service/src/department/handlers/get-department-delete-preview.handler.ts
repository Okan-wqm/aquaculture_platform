/**
 * Get Department Delete Preview Handler
 * Gathers all items that will be affected by department deletion
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { GetDepartmentDeletePreviewQuery } from '../queries/get-department-delete-preview.query';
import { Department } from '../entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import {
  DepartmentDeletePreviewResponse,
  DepartmentEquipmentSummary,
  DepartmentTankSummary,
} from '../dto/department-delete-preview.response';
import { DepartmentResponse } from '../dto/department.response';

@QueryHandler(GetDepartmentDeletePreviewQuery)
export class GetDepartmentDeletePreviewHandler
  implements IQueryHandler<GetDepartmentDeletePreviewQuery, DepartmentDeletePreviewResponse>
{
  private readonly logger = new Logger(GetDepartmentDeletePreviewHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: GetDepartmentDeletePreviewQuery,
  ): Promise<DepartmentDeletePreviewResponse> {
    const { departmentId, tenantId } = query;

    this.logger.log(`Getting delete preview for department: ${departmentId}`);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Find the department
      const department = await queryRunner.manager.findOne(Department, {
        where: { id: departmentId, tenantId, isDeleted: false },
      });

      if (!department) {
        throw new NotFoundException(`Department with ID "${departmentId}" not found`);
      }

      // Get all tanks for this department
      const tanks = await queryRunner.manager.find(Tank, {
        where: { departmentId, tenantId, isActive: true },
      });

      // Get all equipment for this department
      const equipment = await queryRunner.manager.find(Equipment, {
        where: { departmentId, tenantId, isDeleted: false },
      });

      // Check for blockers - tanks with active biomass
      const blockers: string[] = [];
      const tanksWithBiomass = tanks.filter(
        (t) => t.currentBiomass && Number(t.currentBiomass) > 0,
      );

      if (tanksWithBiomass.length > 0) {
        const totalBiomass = tanksWithBiomass.reduce(
          (sum, t) => sum + Number(t.currentBiomass || 0),
          0,
        );
        blockers.push(
          `${tanksWithBiomass.length} tank(s) contain ${totalBiomass.toFixed(2)} kg of active biomass. Please harvest or transfer fish before deleting.`,
        );
      }

      // Build equipment summaries
      const equipmentSummaries: DepartmentEquipmentSummary[] = equipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        code: eq.code,
        status: eq.status,
      }));

      // Build tank summaries
      const tankSummaries: DepartmentTankSummary[] = tanks.map((tank) => ({
        id: tank.id,
        name: tank.name,
        code: tank.code,
        currentBiomass: Number(tank.currentBiomass) || 0,
        hasActiveBiomass: Number(tank.currentBiomass) > 0,
      }));

      // Calculate total count
      const totalCount = equipment.length + tanks.length;

      return {
        department: department as DepartmentResponse,
        canDelete: blockers.length === 0,
        blockers,
        affectedItems: {
          equipment: equipmentSummaries,
          tanks: tankSummaries,
          totalCount,
        },
      };
    });
  }
}
