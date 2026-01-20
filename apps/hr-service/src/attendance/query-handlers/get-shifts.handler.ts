import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
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

  async execute(query: GetShiftsQuery): Promise<Shift[]> {
    const { tenantId, isActive, shiftType } = query;

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

    return queryBuilder.getMany();
  }
}
