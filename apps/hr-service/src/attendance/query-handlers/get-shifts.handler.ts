import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetShiftsQuery } from '../queries/get-shifts.query';
import { Shift } from '../entities/shift.entity';

@QueryHandler(GetShiftsQuery)
export class GetShiftsHandler implements IQueryHandler<GetShiftsQuery> {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(query: GetShiftsQuery): Promise<PaginatedQueryResult<Shift>> {
    const { tenantId, isActive, shiftType } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const queryBuilder = this.shiftRepository
      .createQueryBuilder('s')
      .where('s.tenantId = :tenantId', { tenantId })
      .andWhere('s.isDeleted = false')
      .orderBy('s.displayOrder', 'ASC')
      .addOrderBy('s.name', 'ASC');

    if (isActive !== undefined) {
      queryBuilder.andWhere('s.isActive = :isActive', { isActive });
    }

    if (shiftType) {
      queryBuilder.andWhere('s.shiftType = :shiftType', { shiftType });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
