/**
 * Get Tank Query Handler
 * @module Tank/Handlers
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetTankQuery } from '../queries/get-tank.query';
import { Tank } from '../entities/tank.entity';

@QueryHandler(GetTankQuery)
export class GetTankHandler implements IQueryHandler<GetTankQuery, Tank> {
  constructor(
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(query: GetTankQuery): Promise<Tank> {
    const { tenantId, id } = query;

    const tank = await this.tankRepository.findOne({
      where: { id, tenantId },
      relations: ['department'],
    });

    if (!tank) {
      throw new NotFoundException(`Tank with id "${id}" not found`);
    }

    return tank;
  }
}
