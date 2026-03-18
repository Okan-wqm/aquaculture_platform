import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, EntityManager, Not, In, LessThan } from 'typeorm';
import { listTenantSchemas } from '@platform/backend-common';
import { EmployeeCertification, CertificationStatus } from './entities/employee-certification.entity';
import { CertificationType, CertificationRequirement } from './entities/certification-type.entity';
import { Employee } from '../hr/entities/employee.entity';

/**
 * Scheduled service that handles certification expiry processing.
 *
 * Responsibilities:
 * 1. Mark certifications as EXPIRED when their expiryDate passes
 * 2. Update employee seaWorthy flag when mandatory offshore certifications expire
 *
 * Tenant isolation: iterates all tenant_* schemas via SET search_path on a
 * dedicated QueryRunner, so each tenant's data is processed in isolation.
 */
@Injectable()
export class CertificationExpiryService {
  private readonly logger = new Logger(CertificationExpiryService.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------------------
  // Tenant schema discovery — uses listTenantSchemas from @platform/backend-common
  // ---------------------------------------------------------------------------

  /**
   * Runs daily at 2:00 AM to process expired certifications.
   * - Iterates all tenant schemas
   * - Finds ACTIVE/EXPIRING_SOON certifications whose expiryDate has passed
   * - Sets their status to EXPIRED
   * - Re-evaluates seaWorthy flag for affected employees
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async processExpiredCertifications(): Promise<void> {
    this.logger.log('Starting certification expiry processing...');

    const tenantSchemas = await listTenantSchemas(this.dataSource);
    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found, skipping certification expiry processing');
      return;
    }

    this.logger.log(`Processing certification expiry for ${tenantSchemas.length} tenant schema(s).`);

    let totalExpired = 0;
    let totalSeaWorthyRevoked = 0;

    for (const schema of tenantSchemas) {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();

      try {
        await qr.query(`SET search_path TO "${schema}", hr, public`);

        const manager = qr.manager;
        const now = new Date();

        // Find all certifications that should be marked as expired within this tenant schema
        const expiredCerts = await manager.find(EmployeeCertification, {
          where: {
            status: Not(In([CertificationStatus.EXPIRED, CertificationStatus.REVOKED])),
            expiryDate: LessThan(now),
            isDeleted: false,
          },
        });

        if (expiredCerts.length === 0) {
          continue;
        }

        // Collect unique employee IDs for seaWorthy re-evaluation
        const affectedEmployeeIds = new Set<string>();

        // Batch update statuses
        for (const cert of expiredCerts) {
          cert.status = CertificationStatus.EXPIRED;
          affectedEmployeeIds.add(cert.employeeId);
        }

        await manager.save(EmployeeCertification, expiredCerts);

        this.logger.log(
          `Schema ${schema}: marked ${expiredCerts.length} certification(s) as EXPIRED.`,
        );
        totalExpired += expiredCerts.length;

        // Re-evaluate seaWorthy for each affected employee
        for (const employeeId of affectedEmployeeIds) {
          const updated = await this.evaluateSeaWorthy(manager, employeeId);
          if (updated) {
            totalSeaWorthyRevoked++;
          }
        }
      } catch (err) {
        this.logger.error(
          `Certification expiry failed for schema ${schema}: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      } finally {
        await qr.query('RESET search_path').catch(() => {});
        await qr.release();
      }
    }

    this.logger.log(
      `Certification expiry processing complete. ` +
      `Expired: ${totalExpired}, seaWorthy revoked: ${totalSeaWorthyRevoked}`,
    );
  }

  /**
   * Evaluate whether an employee still meets all mandatory offshore certification requirements.
   * Uses the provided EntityManager (which already has search_path set).
   * Returns true if seaWorthy was changed to false.
   */
  private async evaluateSeaWorthy(
    manager: EntityManager,
    employeeId: string,
  ): Promise<boolean> {
    // Only check employees that are currently seaWorthy
    const employee = await manager.findOne(Employee, {
      where: { id: employeeId, isDeleted: false, seaWorthy: true },
    });

    if (!employee) {
      return false;
    }

    // Find all mandatory offshore certification types within this tenant schema
    const mandatoryCerts = await manager.find(CertificationType, {
      where: {
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
    const activeCerts = await manager.find(EmployeeCertification, {
      where: {
        employeeId,
        status: CertificationStatus.ACTIVE,
        isDeleted: false,
      },
    });

    const allMandatoryMet = mandatoryCerts.every((mc) =>
      activeCerts.some((ac) => ac.certificationTypeId === mc.id),
    );

    if (!allMandatoryMet) {
      await manager.update(
        Employee,
        { id: employeeId },
        { seaWorthy: false },
      );
      this.logger.warn(
        `Employee ${employeeId} seaWorthy set to false — ` +
        `missing mandatory offshore certification(s) after expiry`,
      );
      return true;
    }

    return false;
  }
}
