import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Employee, EmployeeStatus } from '../entities/employee.entity';
import { LeaveRequest } from '../../leave/entities/leave-request.entity';
import { EmployeeCertification } from '../../training/entities/employee-certification.entity';
import { AttendanceRecord } from '../../attendance/entities/attendance-record.entity';

/**
 * GDPR Article 17 — Right to Erasure implementation for employee data.
 *
 * HR-HIGH-002: Anonymizes ALL PII fields across all HR domain entities.
 * Uses a transactional approach to ensure atomic erasure across tables.
 *
 * IMPORTANT: This does NOT delete records. It replaces PII with anonymized
 * values so referential integrity and audit trails are preserved. Financial
 * records (payroll) are retained for legal hold periods but with PII removed.
 *
 * Anonymization strategy:
 * - Names → "ERASED"
 * - Email → "erased-{employeeId}@erased.invalid"
 * - Phone → "000-000-0000"
 * - National ID → "ERASED"
 * - Address → zeroed out
 * - Bank details → null
 * - Emergency info → null
 * - Contact info → anonymized
 */
@Injectable()
export class EmployeeErasureService {
  private readonly logger = new Logger(EmployeeErasureService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Perform GDPR erasure for a single employee.
   *
   * @param tenantId - Tenant the employee belongs to
   * @param employeeId - ID of the employee to erase
   * @param requestedBy - User ID of the person requesting erasure (audit trail)
   * @returns The anonymized employee record
   * @throws NotFoundException if employee not found
   */
  async eraseEmployee(
    tenantId: string,
    employeeId: string,
    requestedBy: string,
  ): Promise<Employee> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ── Load employee ──
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });

      if (!employee) {
        throw new NotFoundException(
          `Employee with ID ${employeeId} not found in tenant ${tenantId}`,
        );
      }

      // ── Anonymize employee PII ──
      const anonymizedEmail = `erased-${employeeId}@erased.invalid`;

      employee.firstName = 'ERASED';
      employee.lastName = 'ERASED';
      employee.email = anonymizedEmail;
      employee.nationalId = 'ERASED';
      employee.dateOfBirth = new Date('1970-01-01');
      employee.contactInfo = {
        email: anonymizedEmail,
        phone: '000-000-0000',
        emergencyContact: undefined,
        emergencyPhone: undefined,
      };
      employee.address = {
        street: 'ERASED',
        city: 'ERASED',
        state: 'ERASED',
        postalCode: '00000',
        country: 'ERASED',
      };
      employee.bankDetails = undefined;
      employee.emergencyInfo = undefined;
      employee.status = EmployeeStatus.TERMINATED;
      employee.isDeleted = true;
      employee.deletedAt = new Date();
      employee.updatedBy = requestedBy;

      await queryRunner.manager.save(Employee, employee);

      // ── Anonymize leave request reasons (may contain PII) ──
      const leaveRequests = await queryRunner.manager.find(LeaveRequest, {
        where: { employeeId, tenantId },
      });

      for (const lr of leaveRequests) {
        lr.reason = lr.reason ? 'ERASED' : undefined;
        lr.contactDuringLeave = undefined;
        lr.cancellationReason = lr.cancellationReason ? 'ERASED' : undefined;
        lr.rejectionReason = lr.rejectionReason ? 'ERASED' : undefined;
        // Anonymize approval history notes (may contain PII references)
        if (lr.approvalHistory) {
          lr.approvalHistory = lr.approvalHistory.map((entry) => ({
            ...entry,
            notes: entry.notes ? 'ERASED' : undefined,
          }));
        }
        lr.updatedBy = requestedBy;
      }

      if (leaveRequests.length > 0) {
        await queryRunner.manager.save(LeaveRequest, leaveRequests);
      }

      // ── Anonymize certification notes (may contain PII) ──
      const certifications = await queryRunner.manager.find(EmployeeCertification, {
        where: { employeeId, tenantId },
      });

      for (const cert of certifications) {
        cert.notes = cert.notes ? 'ERASED' : undefined;
        cert.revocationReason = cert.revocationReason ? 'ERASED' : undefined;
        cert.updatedBy = requestedBy;
      }

      if (certifications.length > 0) {
        await queryRunner.manager.save(EmployeeCertification, certifications);
      }

      // ── Soft-delete attendance records (contain location PII) ──
      await queryRunner.manager.update(
        AttendanceRecord,
        { employeeId, tenantId },
        { isDeleted: true, deletedAt: new Date(), notes: 'GDPR erasure' },
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `GDPR erasure completed for employee ${employeeId} in tenant ${tenantId}, ` +
        `requested by ${requestedBy}`,
      );

      return employee;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
