import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetAllWorkAreaOccupanciesQuery } from '../queries/get-all-work-area-occupancies.query';
import { WorkArea } from '../entities/work-area.entity';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { WorkAreaOccupancyReport } from '../dto/work-area-occupancy.dto';
import { buildOccupancyReport } from './occupancy.util';

/**
 * Occupancy across ALL active work areas on a given date. Mirrors the
 * read-handler tenant scoping (explicit `tenantId` predicate). Loads every
 * active area, then groups date-covering rotations by area and reuses the same
 * occupancy computation as the single-area query (no per-employee detail — the
 * all-areas frontend view does not select it).
 */
@QueryHandler(GetAllWorkAreaOccupanciesQuery)
export class GetAllWorkAreaOccupanciesHandler
  implements IQueryHandler<GetAllWorkAreaOccupanciesQuery>
{
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(
    query: GetAllWorkAreaOccupanciesQuery,
  ): Promise<WorkAreaOccupancyReport[]> {
    const { tenantId, date } = query;

    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) {
      throw new BadRequestException(`Invalid date: ${date}`);
    }

    const workAreas = await this.workAreaRepository.find({
      where: { tenantId, isActive: true, isDeleted: false },
      order: { displayOrder: 'ASC', name: 'ASC' },
    });

    if (workAreas.length === 0) {
      return [];
    }

    const rotations = await this.rotationRepository
      .createQueryBuilder('wr')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status != :cancelled', { cancelled: RotationStatus.CANCELLED })
      .andWhere('wr.startDate <= :date', { date })
      .andWhere('wr.endDate >= :date', { date })
      .getMany();

    const rotationsByArea = new Map<string, WorkRotation[]>();
    for (const rotation of rotations) {
      const existing = rotationsByArea.get(rotation.workAreaId);
      if (existing) {
        existing.push(rotation);
      } else {
        rotationsByArea.set(rotation.workAreaId, [rotation]);
      }
    }

    return workAreas.map((workArea) =>
      buildOccupancyReport(workArea, rotationsByArea.get(workArea.id) ?? [], date, false),
    );
  }
}
