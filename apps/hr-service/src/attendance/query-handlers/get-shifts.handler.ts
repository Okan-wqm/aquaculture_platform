import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetShiftsQuery } from '../queries/get-shifts.query';
import { Shift } from '../entities/shift.entity';

export interface PaginatedShifts {
  items: Shift[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetShiftsQuery)
export class GetShiftsHandler implements IQueryHandler<GetShiftsQuery> {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(query: GetShiftsQuery): Promise<PaginatedShifts> {
    const { tenantId, isActive, shiftType, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

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
