import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { VerifyCertificationCommand } from '../commands/verify-certification.command';
import { EmployeeCertification, CertificationStatus, VerificationStatus } from '../entities/employee-certification.entity';

@CommandHandler(VerifyCertificationCommand)
export class VerifyCertificationHandler
  implements ICommandHandler<VerifyCertificationCommand>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certificationRepository: Repository<EmployeeCertification>,
  ) {}

  async execute(command: VerifyCertificationCommand): Promise<EmployeeCertification> {
    const { tenantId, userId, certificationId, notes } = command;

    const certification = await this.certificationRepository.findOne({
      where: { id: certificationId, tenantId, isDeleted: false },
    });

    if (!certification) {
      throw new NotFoundException(`Certification with ID ${certificationId} not found`);
    }

    if (certification.verificationStatus === VerificationStatus.VERIFIED) {
      throw new BadRequestException('Certification is already verified');
    }

    certification.verificationStatus = VerificationStatus.VERIFIED;
    certification.verifiedBy = userId;
    certification.verifiedAt = new Date();

    if (notes) {
      certification.notes = certification.notes
        ? `${certification.notes}; Verification: ${notes}`
        : `Verification: ${notes}`;
    }

    certification.updatedBy = userId;

    return this.certificationRepository.save(certification);
  }
}
