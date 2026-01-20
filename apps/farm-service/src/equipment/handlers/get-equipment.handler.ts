/**
 * Get Equipment Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetEquipmentQuery } from '../queries/get-equipment.query';
import { Equipment } from '../entities/equipment.entity';

@QueryHandler(GetEquipmentQuery)
export class GetEquipmentHandler implements IQueryHandler<GetEquipmentQuery> {
  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(query: GetEquipmentQuery): Promise<Equipment> {
    const { equipmentId, tenantId, includeRelations } = query;

    const relations: string[] = [];
    if (includeRelations) {
      relations.push('department');
      relations.push('equipmentType');
      relations.push('equipmentSystems');
      relations.push('equipmentSystems.system');
      // relations.push('subEquipment');
    }

    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
      relations,
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
    }

    return equipment;
  }
}
