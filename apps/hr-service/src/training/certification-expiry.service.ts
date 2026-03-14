import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, In } from 'typeorm';
import { EmployeeCertification, CertificationStatus } from './entities/employee-certification.entity';
import { CertificationType, CertificationRequirement } from './entities/certification-type.entity';
import { Employee } from '../hr/entities/employee.entity';

/**
 * Scheduled service that handles certification expiry processing.
 *
 * Responsibilities:
 * 1. Mark certifications as EXPIRED when their expiryDate passes
 * 2. Update employee seaWorthy flag when mandatory offshore certifications expire
 */
@Injectable()
export class CertificationExpiryService {
  private readonly logger = new Logger(CertificationExpiryService.name);

  constructor(
    @InjectRepository(EmployeeCertification)
    private readonly certRepository: Repository<EmployeeCertification>,
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  /**
   * Runs daily at 2:00 AM to process expired certifications.
   * - Finds ACTIVE/EXPIRING_SOON certifications whose expiryDate has passed
   * - Sets their status to EXPIRED
   * - Re-evaluates seaWorthy flag for affected employees
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async processExpiredCertifications(): Promise<void> {
    this.logger.log('Starting certification expiry processing...');

    const now = new Date();

    // Find all certifications that should be marked as expired
    const expiredCerts = await this.certRepository.find({
      where: {
        status: Not(In([CertificationStatus.EXPIRED, CertificationStatus.REVOKED])),
        expiryDate: LessThan(now),
        isDeleted: false,
      },
    });

    if (expiredCerts.length === 0) {
      this.logger.log('No expired certifications found.');
      return;
    }

    this.logger.log(`Found ${expiredCerts.length} certification(s) to expire.`);

    // Collect unique employee+tenant pairs for seaWorthy re-evaluation
    const affectedEmployees = new Map<string, string>(); // employeeId -> tenantId

    // Batch update statuses
    for (const cert of expiredCerts) {
      cert.status = CertificationStatus.EXPIRED;
      affectedEmployees.set(cert.employeeId, cert.tenantId);
    }

    await this.certRepository.save(expiredCerts);

    this.logger.log(`Marked ${expiredCerts.length} certification(s) as EXPIRED.`);

    // Re-evaluate seaWorthy for each affected employee
    let seaWorthyUpdated = 0;
    for (const [employeeId, tenantId] of affectedEmployees) {
      const updated = await this.evaluateSeaWorthy(employeeId, tenantId);
      if (updated) {
        seaWorthyUpdated++;
      }
    }

    this.logger.log(
      `Certification expiry processing complete. ` +
      `Expired: ${expiredCerts.length}, seaWorthy revoked: ${seaWorthyUpdated}`,
    );
  }

  /**
   * Evaluate whether an employee still meets all mandatory offshore certification requirements.
   * Returns true if seaWorthy was changed to false.
   */
  private async evaluateSeaWorthy(employeeId: string, tenantId: string): Promise<boolean> {
    // Only check employees that are currently seaWorthy
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false, seaWorthy: true },
    });

    if (!employee) {
      return false;
    }

    // Find all mandatory offshore certification types for this tenant
    const mandatoryCerts = await this.certTypeRepository.find({
      where: {
        tenantId,
        isOffshoreRequired: true,
        requirement: CertificationRequirement.MANDATORY,
        isActive: true,
        isDeleted: false,
      },
    });

    if (mandatoryCerts.length === 0) {
      return false;
    }

    // Find all ACTIVE certifications for this employee
    const activeCerts = await this.certRepository.find({
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
      await this.employeeRepository.update(
        { id: employeeId, tenantId },
        { seaWorthy: false },
      );
      this.logger.warn(
        `Employee ${employeeId} (tenant: ${tenantId}) seaWorthy set to false — ` +
        `missing mandatory offshore certification(s) after expiry`,
      );
      return true;
    }

    return false;
  }
}
