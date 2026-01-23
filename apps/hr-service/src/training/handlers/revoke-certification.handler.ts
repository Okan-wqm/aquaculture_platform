import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RevokeCertificationCommand } from '../commands/revoke-certification.command';
import { EmployeeCertification, CertificationStatus } from '../entities/employee-certification.entity';
import { CertificationRevokedEvent } from '../events/training.events';

@CommandHandler(RevokeCertificationCommand)
export class RevokeCertificationHandler
  implements ICommandHandler<RevokeCertificationCommand>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certificationRepository: Repository<EmployeeCertification>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: RevokeCertificationCommand): Promise<EmployeeCertification> {
    const { tenantId, userId, certificationId, reason } = command;

    const certification = await this.certificationRepository.findOne({
      where: { id: certificationId, tenantId, isDeleted: false },
    });

    if (!certification) {
      throw new NotFoundException(`Certification with ID ${certificationId} not found`);
    }

    if (certification.status === CertificationStatus.REVOKED) {
      throw new BadRequestException('Certification is already revoked');
    }

    certification.status = CertificationStatus.REVOKED;
    certification.revokedBy = userId;
    certification.revokedAt = new Date();
    certification.revocationReason = reason;
    certification.updatedBy = userId;

    const savedCertification = await this.certificationRepository.save(certification);

    // Publish event for notification/audit purposes
    this.eventBus.publish(new CertificationRevokedEvent(savedCertification));

    return savedCertification;
  }
}
