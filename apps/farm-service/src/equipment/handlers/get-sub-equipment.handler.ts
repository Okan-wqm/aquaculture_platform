/**
 * Get SubEquipment Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSubEquipmentQuery } from '../queries/get-sub-equipment.query';
import { SubEquipment } from '../entities/sub-equipment.entity';

@QueryHandler(GetSubEquipmentQuery)
export class GetSubEquipmentHandler implements IQueryHandler<GetSubEquipmentQuery> {
  constructor(
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
  ) {}

  async execute(query: GetSubEquipmentQuery): Promise<SubEquipment> {
    const { id, tenantId, includeRelations } = query;

    const relations = includeRelations
      ? ['subEquipmentType', 'parentEquipment', 'parentEquipment.equipmentType']
      : ['subEquipmentType'];

    const subEquipment = await this.subEquipmentRepository.findOne({
      where: { id, tenantId },
      relations,
    });

    if (!subEquipment) {
      throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
    }

    return subEquipment;
  }
}
