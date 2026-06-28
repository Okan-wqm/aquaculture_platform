import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventBus } from '@nestjs/cqrs';
import { DataSource, EntityManager, Not, In, LessThan } from 'typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type { CertificationExpiredEvent, CertificationExpiringSoonEvent } from '@platform/event-contracts';
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
    private readonly eventBus: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // Tenant schema discovery — uses listTenantSchemas from @aquaculture/backend-common
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
        for (const cert of expiredCerts) {
          affectedEmployeeIds.add(cert.employeeId);
        }

        // Process each employee atomically: cert expiry + seaWorthy update MUST be atomic.
        // BEFORE this fix: updates ran sequentially without a transaction. A crash between
        // marking a cert EXPIRED and updating seaWorthy=false would leave the employee with
        // an expired cert but seaWorthy=true — allowing unsafe offshore deployment.
        // Each employee gets its OWN QueryRunner to avoid multiple startTransaction() calls
        // on the same connection — reusing a QR across startTransaction/commit/rollback
        // cycles is fragile across drivers. A fresh QR per employee is safe and explicit.
        for (const employeeId of affectedEmployeeIds) {
          const empQr = this.dataSource.createQueryRunner();
          await empQr.connect();
          await empQr.query(`SET search_path TO "${schema}", hr, public`);
          await empQr.startTransaction();
          try {
            const employeeCerts = expiredCerts.filter(c => c.employeeId === employeeId);
            for (const cert of employeeCerts) {
              cert.status = CertificationStatus.EXPIRED;
            }
            await empQr.manager.save(EmployeeCertification, employeeCerts);

            const updated = await this.evaluateSeaWorthy(empQr.manager, employeeId);
            if (updated) {
              totalSeaWorthyRevoked++;
            }

            await empQr.commitTransaction();
            totalExpired += employeeCerts.length;

            // HR-HIGH-012: Emit CertificationExpired NATS events for each expired cert.
            // Published AFTER transaction commit so consumers see consistent state.
            for (const cert of employeeCerts) {
              try {
                // Load certification type name for the event
                const certType = await this.dataSource.manager.findOne(CertificationType, {
                  where: { id: cert.certificationTypeId },
                });
                const expiredEvent: CertificationExpiredEvent = {
                  ...createBaseEvent<CertificationExpiredEvent>('CertificationExpired', cert.tenantId),
                  eventType: 'CertificationExpired' as const,
                  certificationId: cert.id,
                  employeeId: cert.employeeId,
                  certificationTypeName: certType?.name ?? 'Unknown',
                  expiryDate: toEventIso(cert.expiryDate!),
                };
                this.eventBus.publish(expiredEvent);
              } catch (eventErr) {
                this.logger.warn(
                  `Failed to publish CertificationExpired event for cert ${cert.id}: ` +
                  `${eventErr instanceof Error ? eventErr.message : String(eventErr)}`,
                );
              }
            }
          } catch (employeeErr) {
            await empQr.rollbackTransaction();
            this.logger.error(
              `Schema ${schema}: failed to update seaWorthy for employee ${employeeId} — rolled back. ` +
              `${employeeErr instanceof Error ? employeeErr.message : String(employeeErr)}`,
            );
          } finally {
            await empQr.query('RESET search_path').catch(() => {});
            await empQr.release();
          }
        }

        this.logger.log(
          `Schema ${schema}: marked certifications as EXPIRED, seaWorthy evaluated.`,
        );
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
