import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AddEmployeeCertificationCommand } from '../commands/add-employee-certification.command';
import { EmployeeCertification, CertificationStatus, VerificationStatus } from '../entities/employee-certification.entity';
import { CertificationType } from '../entities/certification-type.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { CertificationAddedEvent } from '../events/training.events';

@CommandHandler(AddEmployeeCertificationCommand)
export class AddEmployeeCertificationHandler
  implements ICommandHandler<AddEmployeeCertificationCommand>
{
  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certificationRepository: Repository<EmployeeCertification>,
    @InjectRepository(CertificationType)
    private readonly certificationTypeRepository: Repository<CertificationType>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
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

    // Validate employee
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    // Validate certification type
    const certificationType = await this.certificationTypeRepository.findOne({
      where: { id: certificationTypeId, tenantId, isDeleted: false },
    });

    if (!certificationType) {
      throw new NotFoundException(`Certification type with ID ${certificationTypeId} not found`);
    }

    // Check for existing active certification
    const existingCertification = await this.certificationRepository.findOne({
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
        // Check if expiring soon (within renewal reminder days)
        const reminderDays = certificationType.renewalReminderDays || 30;
        const reminderDate = new Date();
        reminderDate.setDate(reminderDate.getDate() + reminderDays);

        if (expiryDateParsed <= reminderDate) {
          status = CertificationStatus.EXPIRING_SOON;
        }
      }
    }

    const certification = this.certificationRepository.create({
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

    const savedCertification = await this.certificationRepository.save(certification);

    // Publish event for notification/audit purposes
    this.eventBus.publish(new CertificationAddedEvent(savedCertification));

    return savedCertification;
  }
}
