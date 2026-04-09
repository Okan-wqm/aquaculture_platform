import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { DataSource, EntityManager } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { RevokeCertificationCommand } from '../commands/revoke-certification.command';
import { EmployeeCertification, CertificationStatus } from '../entities/employee-certification.entity';
import { CertificationType, CertificationRequirement } from '../entities/certification-type.entity';
import { Employee } from '../../hr/entities/employee.entity';
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

  /**
   * Re-evaluate employee's seaWorthy flag after a certification change.
   * If any mandatory offshore certification is missing (not ACTIVE), set seaWorthy = false.
   *
   * HR-HIGH-014: Uses queryRunner.manager.find/update directly instead of getRepository().
   * All queries include tenantId in WHERE clause for defense-in-depth tenant isolation.
   */
  private async updateSeaWorthyStatus(
    manager: EntityManager,
    employeeId: string,
    tenantId: string,
  ): Promise<void> {
    // SECURITY: All queries include tenantId — no getRepository() bypass
    const mandatoryCerts = await manager.find(CertificationType, {
      where: {
        tenantId,
        isOffshoreRequired: true,
        requirement: CertificationRequirement.MANDATORY,
        isActive: true,
        isDeleted: false,
      },
    });

    if (mandatoryCerts.length === 0) {
      return;
    }

    const activeCerts = await manager.find(EmployeeCertification, {
      where: {
        employeeId,
        tenantId,
        status: CertificationStatus.ACTIVE,
        isDeleted: false,
      },
    });

    const allMandatoryMet = mandatoryCerts.every((mc) =>
      activeCerts.some((ac) => ac.certificationTypeId === mc.id),
    );

    if (!allMandatoryMet) {
      // SECURITY: tenantId in WHERE prevents cross-tenant update
      await manager.update(
        Employee,
        { id: employeeId, tenantId },
        { seaWorthy: false },
      );
      this.logger.log(
        `Employee ${employeeId} seaWorthy set to false — missing mandatory offshore certification(s)`,
      );
    }
  }

  async execute(command: RevokeCertificationCommand): Promise<EmployeeCertification> {
    const { tenantId, userId, certificationId, reason } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // HR-HIGH-014: Use queryRunner.manager directly (not getRepository)
      // to ensure all queries use the transaction's connection and include tenantId.
      const certification = await queryRunner.manager.findOne(EmployeeCertification, {
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

      await queryRunner.manager.save(EmployeeCertification, certification);

      // After revoking, check if employee still meets all mandatory offshore certifications.
      // If not, set seaWorthy = false.
      await this.updateSeaWorthyStatus(
        queryRunner.manager,
        certification.employeeId,
        tenantId,
      );

      // Re-fetch with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(EmployeeCertification, {
        where: { id: certificationId, tenantId },
        relations: ['employee', 'certificationType'],
      });

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new CertificationRevokedEvent(result!));

      return result!;
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
