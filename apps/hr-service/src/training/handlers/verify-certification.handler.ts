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
      // HR-HIGH-014: Use queryRunner.manager directly (not getRepository)
      // to ensure all queries include tenantId for tenant isolation.
      const certification = await queryRunner.manager.findOne(EmployeeCertification, {
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

      await queryRunner.manager.save(EmployeeCertification, certification);

      // Re-fetch with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(EmployeeCertification, {
        where: { id: certificationId, tenantId },
        relations: ['employee', 'certificationType'],
      });

      await queryRunner.commitTransaction();

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
