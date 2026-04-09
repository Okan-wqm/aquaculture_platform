import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { AddEmployeeCertificationCommand } from '../commands/add-employee-certification.command';
import { EmployeeCertification, CertificationStatus, VerificationStatus } from '../entities/employee-certification.entity';
import { CertificationType } from '../entities/certification-type.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { createCertificationAddedEvent } from '../events/training.events';

/**
 * HR-HIGH-013: All certification operations are now transactional.
 * Multiple entity saves happen inside a single QueryRunner transaction.
 * Partial update on failure is STRUCTURALLY IMPOSSIBLE.
 */
@CommandHandler(AddEmployeeCertificationCommand)
export class AddEmployeeCertificationHandler
  implements ICommandHandler<AddEmployeeCertificationCommand>
{
  private readonly logger = new Logger(AddEmployeeCertificationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: AddEmployeeCertificationCommand): Promise<EmployeeCertification> {
    const {
      tenantId,
      userId,
      employeeId,
      certificationTypeId,
      issueDate,
      expiryDate,
      issuingAuthority,
      externalCertificationId,
      notes,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate employee
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Validate certification type
      const certificationType = await queryRunner.manager.findOne(CertificationType, {
        where: { id: certificationTypeId, tenantId, isDeleted: false },
      });

      if (!certificationType) {
        throw new NotFoundException(`Certification type with ID ${certificationTypeId} not found`);
      }

      // Check for existing active certification
      const existingCertification = await queryRunner.manager.findOne(EmployeeCertification, {
        where: {
          tenantId,
          employeeId,
          certificationTypeId,
          status: CertificationStatus.ACTIVE,
          isDeleted: false,
        },
      });

      if (existingCertification) {
        throw new BadRequestException(
          `Employee already has an active ${certificationType.name} certification`,
        );
      }

      // Determine status based on expiry date
      let status = CertificationStatus.ACTIVE;
      let expiryDateParsed: Date | undefined;

      if (expiryDate) {
        expiryDateParsed = new Date(expiryDate);
        const today = new Date();

        if (expiryDateParsed < today) {
          status = CertificationStatus.EXPIRED;
        } else {
          const reminderDays = certificationType.renewalReminderDays || 30;
          const reminderDate = new Date();
          reminderDate.setDate(reminderDate.getDate() + reminderDays);

          if (expiryDateParsed <= reminderDate) {
            status = CertificationStatus.EXPIRING_SOON;
          }
        }
      }

      const certification = queryRunner.manager.create(EmployeeCertification, {
        tenantId,
        employeeId,
        certificationTypeId,
        issueDate: new Date(issueDate),
        expiryDate: expiryDateParsed,
        status,
        verificationStatus: VerificationStatus.PENDING_VERIFICATION,
        issuingAuthority: issuingAuthority || certificationType.issuingAuthority,
        externalCertificationId,
        notes,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedCertification = await queryRunner.manager.save(EmployeeCertification, certification);

      // Re-fetch with relations within the SAME transaction
      const result = await queryRunner.manager.findOne(EmployeeCertification, {
        where: { id: savedCertification.id, tenantId },
        relations: ['employee', 'certificationType'],
      });

      await queryRunner.commitTransaction();

      // HR-MEDIUM-007: Publish flat BaseEvent-conforming event via factory function.
      // The old class-based CertificationAddedEvent lacked eventId/timestamp/version/tenantId.
      this.eventBus.publish(createCertificationAddedEvent(result!));

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to add certification for employee ${employeeId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to add employee certification');
    } finally {
      await queryRunner.release();
    }
  }
}
