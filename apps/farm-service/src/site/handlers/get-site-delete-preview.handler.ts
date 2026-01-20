/**
 * Get Site Delete Preview Handler
 * Gathers all items that will be affected by site deletion
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { GetSiteDeletePreviewQuery } from '../queries/get-site-delete-preview.query';
import { Site } from '../entities/site.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import {
  SiteDeletePreviewResponse,
  DepartmentSummary,
  SystemSummary,
  EquipmentSummary,
  TankSummary,
} from '../dto/site-delete-preview.response';

@QueryHandler(GetSiteDeletePreviewQuery)
export class GetSiteDeletePreviewHandler
  implements IQueryHandler<GetSiteDeletePreviewQuery, SiteDeletePreviewResponse>
{
  private readonly logger = new Logger(GetSiteDeletePreviewHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(
    query: GetSiteDeletePreviewQuery,
  ): Promise<SiteDeletePreviewResponse> {
    const { siteId, tenantId } = query;

    this.logger.log(`Getting delete preview for site: ${siteId}`);

    // Find the site
    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId, isDeleted: false },
    });

    if (!site) {
      throw new NotFoundException(`Site with ID "${siteId}" not found`);
    }

    // Get all departments for this site
    const departments = await this.departmentRepository.find({
      where: { siteId, tenantId, isDeleted: false },
    });

    const departmentIds = departments.map((d) => d.id);

    // Get all systems for this site
    const systems = await this.systemRepository.find({
      where: { siteId, tenantId, isDeleted: false },
    });

    // Get all tanks for departments of this site
    let tanks: Tank[] = [];
    if (departmentIds.length > 0) {
      tanks = await this.tankRepository
        .createQueryBuilder('tank')
        .where('tank.tenantId = :tenantId', { tenantId })
        .andWhere('tank.departmentId IN (:...departmentIds)', { departmentIds })
        .andWhere('tank.isActive = true')
        .getMany();
    }

    // Get all equipment for departments of this site
    let equipment: Equipment[] = [];
    if (departmentIds.length > 0) {
      equipment = await this.equipmentRepository
        .createQueryBuilder('equipment')
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

    // Build system summaries with equipment counts
    const systemSummaries: SystemSummary[] = await Promise.all(
      systems.map(async (sys) => {
        // Count equipment linked to this system via EquipmentSystem junction table
        // For now, we'll count equipment in the same site (simplified)
        const equipmentCount = 0; // TODO: Query EquipmentSystem junction table

        return {
          id: sys.id,
          name: sys.name,
          code: sys.code,
          equipmentCount,
        };
      }),
    );

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
      site: site as any, // Cast to SiteResponse
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
  }
}
