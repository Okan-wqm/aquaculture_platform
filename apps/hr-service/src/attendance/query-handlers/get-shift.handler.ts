import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetShiftQuery } from '../queries/get-shift.query';
import { Shift } from '../entities/shift.entity';

/**
 * WHY THIS FILE EXISTS:
 * Backend for the FE `GetShift` query (attendance.operations.ts → useShift).
 * Before this handler existed the query 400'd (GraphQL FE↔backend drift —
 * the FE shipped ahead of the backend). Mirrors GetShiftsHandler's
 * tenant-scoped, soft-delete-aware lookup but resolves a SINGLE shift by id.
 *
 * Tenant isolation: the `s.tenantId = :tenantId` predicate means a shift that
 * belongs to another tenant is invisible (surfaces as NotFound, never leaks).
 */
@QueryHandler(GetShiftQuery)
export class GetShiftHandler implements IQueryHandler<GetShiftQuery> {
  constructor(
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(query: GetShiftQuery): Promise<Shift> {
    const { tenantId, id } = query;

    const shift = await this.shiftRepository
      .createQueryBuilder('s')
      .where('s.id = :id', { id })
      .andWhere('s.tenantId = :tenantId', { tenantId })
      .andWhere('s.isDeleted = false')
      .getOne();

    if (!shift) {
      throw new NotFoundException(`Shift with ID ${id} not found`);
    }

    return shift;
  }
}
