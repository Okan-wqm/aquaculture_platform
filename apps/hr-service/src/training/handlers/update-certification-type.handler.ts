import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateCertificationTypeCommand } from '../commands/update-certification-type.command';
import { CertificationType } from '../entities/certification-type.entity';

@CommandHandler(UpdateCertificationTypeCommand)
export class UpdateCertificationTypeHandler
  implements ICommandHandler<UpdateCertificationTypeCommand>
{
  private readonly logger = new Logger(UpdateCertificationTypeHandler.name);

  constructor(
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(command: UpdateCertificationTypeCommand): Promise<CertificationType> {
    const { tenantId, userId, input } = command;
    const { id, ...patch } = input;

    const certType = await this.certTypeRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });
    if (!certType) {
      throw new NotFoundException(`Certification type with ID ${id} not found`);
    }

    // Apply only keys the caller actually supplied. Undefined keys are left
    // untouched so a partial patch never clobbers existing values.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        Reflect.set(certType, key, value);
      }
    }
    certType.updatedBy = userId;

    const saved = await this.certTypeRepository.save(certType);
    this.logger.log(`Certification type ${saved.id} updated for tenant ${tenantId}`);
    return saved;
  }
}
