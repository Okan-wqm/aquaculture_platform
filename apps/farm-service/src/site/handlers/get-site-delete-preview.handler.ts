/**
 * Get Site Delete Preview Handler
 * Gathers all items that will be affected by site deletion
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { GetSiteDeletePreviewQuery } from '../queries/get-site-delete-preview.query';
import { Site } from '../entities/site.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import {
  SiteDeletePreviewResponse,
  DepartmentSummary,
  SystemSummary,
  EquipmentSummary,
  TankSummary,
} from '../dto/site-delete-preview.response';
import { SiteResponse } from '../dto/site.response';

@QueryHandler(GetSiteDeletePreviewQuery)
export class GetSiteDeletePreviewHandler
  implements IQueryHandler<GetSiteDeletePreviewQuery, SiteDeletePreviewResponse>
{
  private readonly logger = new Logger(GetSiteDeletePreviewHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: GetSiteDeletePreviewQuery,
  ): Promise<SiteDeletePreviewResponse> {
    const { siteId, tenantId } = query;

    this.logger.log(`Getting delete preview for site: ${siteId}`);

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Find the site
      const site = await queryRunner.manager.findOne(Site, {
        where: { id: siteId, tenantId, isDeleted: false },
      });

      if (!site) {
        throw new NotFoundException(`Site with ID "${siteId}" not found`);
      }

      // Get all departments for this site
      const departments = await queryRunner.manager.find(Department, {
        where: { siteId, tenantId, isDeleted: false },
      });

      const departmentIds = departments.map((d) => d.id);

      // Get all systems for this site
      const systems = await queryRunner.manager.find(System, {
        where: { siteId, tenantId, isDeleted: false },
      });

      // Get all tanks for departments of this site
      let tanks: Tank[] = [];
      if (departmentIds.length > 0) {
        tanks = await queryRunner.manager
          .createQueryBuilder(Tank, 'tank')
          .where('tank.tenantId = :tenantId', { tenantId })
          .andWhere('tank.departmentId IN (:...departmentIds)', { departmentIds })
          .andWhere('tank.isActive = true')
          .getMany();
      }

      // Get all equipment for departments of this site
      let equipment: Equipment[] = [];
      if (departmentIds.length > 0) {
        equipment = await queryRunner.manager
          .createQueryBuilder(Equipment, 'equipment')
          .where('equipment.tenantId = :tenantId', { tenantId })
          .andWhere('equipment.departmentId IN (:...departmentIds)', { departmentIds })
          .andWhere('equipment.isDeleted = false')
          .getMany();
      }

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

      // Build department summaries with counts
      const departmentSummaries: DepartmentSummary[] = await Promise.all(
        departments.map(async (dept) => {
          const tankCount = tanks.filter((t) => t.departmentId === dept.id).length;
          const equipmentCount = equipment.filter((e) => e.departmentId === dept.id).length;

          return {
            id: dept.id,
            name: dept.name,
            code: dept.code,
            equipmentCount,
            tankCount,
          };
        }),
      );

      // Build system summaries with equipment counts via the
      // `equipment_systems` junction table. A single equipment item can
      // belong to multiple systems (many-to-many) so the junction owns
      // the truth; a naive count of `equipment.systemId === sys.id`
      // would miss equipment linked via the junction and over/under-
      // count shared equipment.
      //
      // One aggregate query → map, rather than one query per system.
      const systemIds = systems.map((s) => s.id);
      const systemEquipmentCounts = new Map<string, number>();
      if (systemIds.length > 0) {
        const links = await queryRunner.manager.find(EquipmentSystem, {
          where: { tenantId, systemId: In(systemIds) },
          select: ['systemId'],
        });
        for (const link of links) {
          systemEquipmentCounts.set(
            link.systemId,
            (systemEquipmentCounts.get(link.systemId) ?? 0) + 1,
          );
        }
      }

      const systemSummaries: SystemSummary[] = systems.map((sys) => ({
        id: sys.id,
        name: sys.name,
        code: sys.code,
        equipmentCount: systemEquipmentCounts.get(sys.id) ?? 0,
      }));

      // Build equipment summaries
      const equipmentSummaries: EquipmentSummary[] = equipment.map((eq) => ({
        id: eq.id,
        name: eq.name,
        code: eq.code,
        status: eq.status,
      }));

      // Build tank summaries
      const tankSummaries: TankSummary[] = tanks.map((tank) => ({
        id: tank.id,
        name: tank.name,
        code: tank.code,
        currentBiomass: Number(tank.currentBiomass) || 0,
        hasActiveBiomass: Number(tank.currentBiomass) > 0,
      }));

      // Calculate total count
      const totalCount =
        departments.length +
        systems.length +
        equipment.length +
        tanks.length;

      return {
        site: site as SiteResponse,
        canDelete: blockers.length === 0,
        blockers,
        affectedItems: {
          departments: departmentSummaries,
          systems: systemSummaries,
          equipment: equipmentSummaries,
          tanks: tankSummaries,
          totalCount,
        },
      };
    });
  }
}
