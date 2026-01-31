import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkRotationsQuery } from '../queries/get-work-rotations.query';
import { WorkRotation } from '../entities/work-rotation.entity';

export interface PaginatedWorkRotations {
  items: WorkRotation[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetWorkRotationsQuery)
export class GetWorkRotationsHandler implements IQueryHandler<GetWorkRotationsQuery> {
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetWorkRotationsQuery): Promise<PaginatedWorkRotations> {
    const { tenantId, employeeId, workAreaId, status, startDate, endDate, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

    const queryBuilder = this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .orderBy('wr.startDate', 'DESC');

    if (employeeId) {
      queryBuilder.andWhere('wr.employeeId = :employeeId', { employeeId });
    }

    if (workAreaId) {
      queryBuilder.andWhere('wr.workAreaId = :workAreaId', { workAreaId });
    }

    if (status) {
      queryBuilder.andWhere('wr.status = :status', { status });
    }

    if (startDate) {
      queryBuilder.andWhere('wr.endDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('wr.startDate <= :endDate', { endDate });
    }

    const [items, total] = await queryBuilder
      .skip(effectiveOffset)
      .take(effectiveLimit)
      .getManyAndCount();

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
