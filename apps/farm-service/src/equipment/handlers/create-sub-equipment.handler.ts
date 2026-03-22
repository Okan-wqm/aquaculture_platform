/**
 * Create SubEquipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CreateSubEquipmentCommand } from '../commands/create-sub-equipment.command';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { SubEquipmentType } from '../entities/sub-equipment-type.entity';
import { Equipment, EquipmentStatus } from '../entities/equipment.entity';

@CommandHandler(CreateSubEquipmentCommand)
export class CreateSubEquipmentHandler implements ICommandHandler<CreateSubEquipmentCommand, SubEquipment> {
  private readonly logger = new Logger(CreateSubEquipmentHandler.name);

  constructor(
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
    @InjectRepository(SubEquipmentType)
    private readonly subEquipmentTypeRepository: Repository<SubEquipmentType>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: CreateSubEquipmentCommand): Promise<SubEquipment> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating sub-equipment "${input.name}" for tenant ${tenantId}`);

    // Verify parent equipment exists and belongs to tenant
    const parentEquipment = await this.equipmentRepository.findOne({
      where: { id: input.parentEquipmentId, tenantId },
      relations: ['equipmentType'],
    });
    if (!parentEquipment) {
      throw new NotFoundException(`Parent equipment with ID "${input.parentEquipmentId}" not found`);
    }

    // Verify sub-equipment type exists
    const subEquipmentType = await this.subEquipmentTypeRepository.findOne({
      where: { id: input.subEquipmentTypeId },
    });
    if (!subEquipmentType) {
      throw new NotFoundException(`Sub-equipment type with ID "${input.subEquipmentTypeId}" not found`);
    }

    // Validate compatibility - check if this sub-equipment type is compatible with parent equipment type
    if (subEquipmentType.compatibleEquipmentTypes && subEquipmentType.compatibleEquipmentTypes.length > 0) {
      const parentTypeCode = parentEquipment.equipmentType?.code;
      if (parentTypeCode && !subEquipmentType.compatibleEquipmentTypes.includes(parentTypeCode)) {
        throw new BadRequestException(
          `Sub-equipment type "${subEquipmentType.name}" is not compatible with parent equipment type "${parentEquipment.equipmentType?.name}"`
        );
      }
    }

    // Validate specifications against schema if provided
    if (input.specifications && subEquipmentType.specificationSchema) {
      this.validateSpecifications(input.specifications, subEquipmentType.specificationSchema);
    }

    const normalizedCode = input.code.toUpperCase();

    // Check for duplicate code within tenant and parent equipment
    const existingByCode = await this.subEquipmentRepository.findOne({
      where: { tenantId, parentEquipmentId: input.parentEquipmentId, code: normalizedCode },
    });
    if (existingByCode) {
      throw new ConflictException(
        `Sub-equipment with code "${normalizedCode}" already exists for this parent equipment`
      );
    }

    // Check for duplicate serial number if provided
    if (input.serialNumber) {
      const existingBySerial = await this.subEquipmentRepository.findOne({
        where: { tenantId, serialNumber: input.serialNumber },
      });
      if (existingBySerial) {
        throw new ConflictException(`Sub-equipment with serial number "${input.serialNumber}" already exists`);
      }
    }

    // Create sub-equipment entity
    const subEquipment = this.subEquipmentRepository.create({
      tenantId,
      parentEquipmentId: input.parentEquipmentId,
      subEquipmentTypeId: input.subEquipmentTypeId,
      name: input.name,
      code: normalizedCode,
      description: input.description,
      manufacturer: input.manufacturer,
      model: input.model,
      serialNumber: input.serialNumber,
      status: input.status ?? EquipmentStatus.OPERATIONAL,
      specifications: input.specifications,
      installationDate: input.installationDate,
      notes: input.notes,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedSubEquipment = await this.subEquipmentRepository.save(subEquipment);

    // Increment parent equipment's subEquipmentCount
    await this.equipmentRepository.increment(
      { id: input.parentEquipmentId },
      'subEquipmentCount',
      1
    );

    this.logger.log(`Sub-equipment "${savedSubEquipment.name}" created with ID ${savedSubEquipment.id}`);

    // Load relations for return
    return this.subEquipmentRepository.findOne({
      where: { id: savedSubEquipment.id },
      relations: ['subEquipmentType', 'parentEquipment'],
    }) as Promise<SubEquipment>;
  }

  private validateSpecifications(
    specs: Record<string, unknown>,
    schema: { fields?: Array<{ name: string; required?: boolean; type: string }> }
  ): void {
    if (!schema.fields) return;

    for (const field of schema.fields) {
      if (field.required && (specs[field.name] === undefined || specs[field.name] === null)) {
        throw new BadRequestException(`Required specification field "${field.name}" is missing`);
      }
    }
  }
}
