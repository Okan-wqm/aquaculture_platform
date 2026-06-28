import { ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateCertificationTypeCommand } from '../commands/create-certification-type.command';
import { CertificationType } from '../entities/certification-type.entity';

@CommandHandler(CreateCertificationTypeCommand)
export class CreateCertificationTypeHandler
  implements ICommandHandler<CreateCertificationTypeCommand>
{
  private readonly logger = new Logger(CreateCertificationTypeHandler.name);

  constructor(
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(command: CreateCertificationTypeCommand): Promise<CertificationType> {
    const { tenantId, userId, input } = command;

    // Per-tenant code uniqueness is the business key (@Index(['tenantId','code'], unique)).
    // Fail-fast with a 409 instead of surfacing a raw DB unique-violation.
    const existing = await this.certTypeRepository.findOne({
      where: { tenantId, code: input.code, isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(
        `Certification type with code ${input.code} already exists for this tenant`,
      );
    }

    const certType = this.certTypeRepository.create({
      ...input,
      tenantId,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.certTypeRepository.save(certType);
    this.logger.log(`Certification type ${saved.id} (${saved.code}) created for tenant ${tenantId}`);
    return saved;
  }
}
