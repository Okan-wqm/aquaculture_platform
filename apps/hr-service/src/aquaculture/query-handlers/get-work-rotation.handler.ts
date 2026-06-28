import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetWorkRotationQuery } from '../queries/get-work-rotation.query';
import { WorkRotation } from '../entities/work-rotation.entity';

/**
 * Single work-rotation read. Mirrors GetWorkRotationsHandler tenant scoping
 * (explicit `tenantId` predicate, isDeleted filter, employee + workArea joins).
 */
@QueryHandler(GetWorkRotationQuery)
export class GetWorkRotationHandler implements IQueryHandler<GetWorkRotationQuery> {
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetWorkRotationQuery): Promise<WorkRotation> {
    const { tenantId, id } = query;

    const rotation = await this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.id = :id', { id })
      .andWhere('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .getOne();

    if (!rotation) {
      throw new NotFoundException(`Work rotation not found: ${id}`);
    }

    return rotation;
  }
}
