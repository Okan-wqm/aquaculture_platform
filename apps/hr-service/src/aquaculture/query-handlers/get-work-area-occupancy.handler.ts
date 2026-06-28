import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkAreaOccupancyQuery } from '../queries/get-work-area-occupancy.query';
import { WorkArea } from '../entities/work-area.entity';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { WorkAreaOccupancyReport } from '../dto/work-area-occupancy.dto';
import { buildOccupancyReport } from './occupancy.util';

/**
 * Occupancy for a SINGLE work area on a given date. Mirrors the read-handler
 * tenant scoping (explicit `tenantId` predicate). Counts rotations whose date
 * range covers the report date; per-employee detail is included.
 */
@QueryHandler(GetWorkAreaOccupancyQuery)
export class GetWorkAreaOccupancyHandler
  implements IQueryHandler<GetWorkAreaOccupancyQuery>
{
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetWorkAreaOccupancyQuery): Promise<WorkAreaOccupancyReport> {
    const { tenantId, workAreaId, date } = query;

    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) {
      throw new BadRequestException(`Invalid date: ${date}`);
    }

    const workArea = await this.workAreaRepository.findOne({
      where: { id: workAreaId, tenantId, isDeleted: false },
    });

    if (!workArea) {
      throw new NotFoundException(`Work area not found: ${workAreaId}`);
    }

    const rotations = await this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.workAreaId = :workAreaId', { workAreaId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status != :cancelled', { cancelled: RotationStatus.CANCELLED })
      .andWhere('wr.startDate <= :date', { date })
      .andWhere('wr.endDate >= :date', { date })
      .getMany();

    return buildOccupancyReport(workArea, rotations, date, true);
  }
}
