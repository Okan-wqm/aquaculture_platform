import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { VerifyCertificationCommand } from '../commands/verify-certification.command';
import { EmployeeCertification, CertificationStatus, VerificationStatus } from '../entities/employee-certification.entity';

@CommandHandler(VerifyCertificationCommand)
export class VerifyCertificationHandler
  implements ICommandHandler<VerifyCertificationCommand>
{
  private readonly logger = new Logger(VerifyCertificationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: VerifyCertificationCommand): Promise<EmployeeCertification> {
    const { tenantId, userId, certificationId, notes } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const certificationRepo = queryRunner.manager.getRepository(EmployeeCertification);

      const certification = await certificationRepo.findOne({
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

      await certificationRepo.save(certification);

      await queryRunner.commitTransaction();

      // Re-fetch with relations so GraphQL response includes employee & certificationType
      const result = await this.dataSource.getRepository(EmployeeCertification).findOne({
        where: { id: certificationId, tenantId },
        relations: ['employee', 'certificationType'],
      });
      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to verify certification ${certificationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to verify certification');
    } finally {
      await queryRunner.release();
    }
  }
}
