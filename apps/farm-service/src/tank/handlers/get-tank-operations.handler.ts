/**
 * GetTankOperationsHandler
 *
 * GetTankOperationsQuery'yi işler ve tank operasyonlarını döner.
 *
 * @module Tank/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual, In } from 'typeorm';
import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { GetTankOperationsQuery } from '../queries/get-tank-operations.query';
import { Tank } from '../entities/tank.entity';
import { TankOperation } from '../../batch/entities/tank-operation.entity';

@Injectable()
@QueryHandler(GetTankOperationsQuery)
export class GetTankOperationsHandler implements IQueryHandler<GetTankOperationsQuery, PaginatedQueryResult<TankOperation>> {
  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
  ) {}

  async execute(query: GetTankOperationsQuery): Promise<PaginatedQueryResult<TankOperation>> {
    const { tenantId, tankId, filter, page, limit, sortBy, sortOrder } = query;

    // Tank'ı doğrula
    const tank = await this.tankRepository.findOne({
      where: { id: tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${tankId} bulunamadı`);
    }

    const queryBuilder = this.operationRepository
      .createQueryBuilder('op')
      .leftJoinAndSelect('op.batch', 'batch')
      .where('op.tenantId = :tenantId', { tenantId })
      .andWhere('op.tankId = :tankId', { tankId })
      .andWhere('op.isDeleted = false');

    // Filtreler
    if (filter) {
      if (filter.operationType?.length) {
        queryBuilder.andWhere('op.operationType IN (:...types)', {
          types: filter.operationType,
        });
      }

      if (filter.batchId) {
        queryBuilder.andWhere('op.batchId = :batchId', {
          batchId: filter.batchId,
        });
      }

      if (filter.fromDate && filter.toDate) {
        queryBuilder.andWhere('op.operationDate BETWEEN :from AND :to', {
          from: filter.fromDate,
          to: filter.toDate,
        });
      } else if (filter.fromDate) {
        queryBuilder.andWhere('op.operationDate >= :from', {
          from: filter.fromDate,
        });
      } else if (filter.toDate) {
        queryBuilder.andWhere('op.operationDate <= :to', {
          to: filter.toDate,
        });
      }

      if (filter.performedBy) {
        queryBuilder.andWhere('op.performedBy = :performedBy', {
          performedBy: filter.performedBy,
        });
      }
    }

    // Sıralama
    const validSortFields = ['operationDate', 'operationType', 'quantity', 'createdAt'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'operationDate';
    queryBuilder.orderBy(`op.${sortField}`, sortOrder);

    // Toplam sayı
    const total = await queryBuilder.getCount();

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    const operations = await queryBuilder.getMany();

    return createPaginatedQueryResult(operations, page, limit, total);
  }
}
