import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListWorkersQuery } from '../queries/list-workers.query';
import { Worker } from '../entities/worker.entity';

@QueryHandler(ListWorkersQuery)
export class ListWorkersHandler implements IQueryHandler<ListWorkersQuery> {
  constructor(
    @InjectRepository(Worker)
    private readonly workerRepository: Repository<Worker>,
  ) {}

  async execute(query: ListWorkersQuery): Promise<Worker[]> {
    const { tenantId } = query;

    return this.workerRepository.find({
      where: { tenantId, isDeleted: false },
      order: { firstName: 'ASC', lastName: 'ASC' },
    });
  }
}
