import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { RevokeCertificationCommand } from '../commands/revoke-certification.command';
import { EmployeeCertification, CertificationStatus } from '../entities/employee-certification.entity';
import { CertificationRevokedEvent } from '../events/training.events';

@CommandHandler(RevokeCertificationCommand)
export class RevokeCertificationHandler
  implements ICommandHandler<RevokeCertificationCommand>
{
  private readonly logger = new Logger(RevokeCertificationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: RevokeCertificationCommand): Promise<EmployeeCertification> {
    const { tenantId, userId, certificationId, reason } = command;

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

      if (certification.status === CertificationStatus.REVOKED) {
        throw new BadRequestException('Certification is already revoked');
      }

      certification.status = CertificationStatus.REVOKED;
      certification.revokedBy = userId;
      certification.revokedAt = new Date();
      certification.revocationReason = reason;
      certification.updatedBy = userId;

      const savedCertification = await certificationRepo.save(certification);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new CertificationRevokedEvent(savedCertification));

      return savedCertification;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to revoke certification ${certificationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to revoke certification');
    } finally {
      await queryRunner.release();
    }
  }
}
