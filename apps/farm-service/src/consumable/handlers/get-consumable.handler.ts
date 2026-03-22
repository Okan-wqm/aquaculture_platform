import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetConsumableQuery } from '../queries/get-consumable.query';
import { Consumable } from '../entities/consumable.entity';

@QueryHandler(GetConsumableQuery)
export class GetConsumableHandler implements IQueryHandler<GetConsumableQuery> {
  constructor(
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
  ) {}

  async execute(query: GetConsumableQuery): Promise<Consumable> {
    const { consumableId, tenantId } = query;

    const consumable = await this.consumableRepository.findOne({
      where: { id: consumableId, tenantId },
    });

    if (!consumable) {
      throw new NotFoundException(`Consumable with ID "${consumableId}" not found`);
    }

    return consumable;
  }
}
