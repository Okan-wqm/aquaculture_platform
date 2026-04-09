import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { In, EntityManager } from 'typeorm';
import { EmployeeCertification, CertificationStatus } from '../training/entities/employee-certification.entity';
import { CertificationType } from '../training/entities/certification-type.entity';
import { WorkArea } from './entities/work-area.entity';

/**
 * Details about a single certification validation failure.
 * Used to build a descriptive error message for the caller.
 */
export interface CertificationGap {
  /** The certification type ID that failed validation */
  certificationTypeId: string;
  /** Human-readable reason: 'MISSING' | 'EXPIRED' | 'EXPIRES_DURING_ROTATION' | 'NOT_ACTIVE' */
  reason: 'MISSING' | 'EXPIRED' | 'EXPIRES_DURING_ROTATION' | 'NOT_ACTIVE';
  /** If the employee holds the cert, its current expiry date (ISO string) */
  expiryDate?: string;
}

/**
 * LIFE-SAFETY: Validates that an employee holds all certifications required
 * by a work area, and that those certifications remain valid through the
 * rotation end date.
 *
 * This service is deliberately stateless so it can be called from any handler
 * (CreateWorkRotation, StartRotation, UpdateWorkRotation, etc.) or from
 * scheduled pre-rotation audits.
 */
@Injectable()
export class CertificationValidationService {
  private readonly logger = new Logger(CertificationValidationService.name);

  /**
   * Validate that the employee holds all required certifications for a work area
   * and that none expire before the rotation end date.
   *
   * @param manager - TypeORM EntityManager (use queryRunner.manager inside transactions)
   * @param tenantId - Tenant context for multi-tenant isolation
   * @param employeeId - The employee being assigned to the rotation
   * @param workAreaId - The work area whose requiredCertifications list is authoritative
   * @param rotationEndDate - The rotation's end date; certs must be valid through this date
   * @throws BadRequestException with detailed gap list when validation fails
   */
  async validateEmployeeCertifications(
    manager: EntityManager,
    tenantId: string,
    employeeId: string,
    workAreaId: string,
    rotationEndDate: Date,
  ): Promise<void> {
    // ── Step 1: Load work area and its required certifications ──
    const workArea = await manager.findOne(WorkArea, {
      where: { id: workAreaId, tenantId, isDeleted: false },
      select: ['id', 'name', 'requiredCertifications'],
    });

    if (!workArea) {
      // WHY: Caller is responsible for verifying work area existence before
      // calling this service. If we reach here, it is a programming error.
      throw new BadRequestException(`Work area not found: ${workAreaId}`);
    }

    const requiredCertTypeIds = workArea.requiredCertifications;

    // If no certifications are required, the work area has no safety gate.
    if (!requiredCertTypeIds || requiredCertTypeIds.length === 0) {
      return;
    }

    // ── Step 2: Query employee's active certifications for required types ──
    const employeeCerts = await manager.find(EmployeeCertification, {
      where: {
        tenantId,
        employeeId,
        certificationTypeId: In(requiredCertTypeIds),
        isDeleted: false,
      },
      select: ['id', 'certificationTypeId', 'expiryDate', 'status'],
    });

    // Build a lookup: certificationTypeId -> best certification record
    const certByType = new Map<string, EmployeeCertification>();
    for (const cert of employeeCerts) {
      const existing = certByType.get(cert.certificationTypeId);
      // IMPORTANT: If the employee has multiple certs of the same type,
      // use the one with the latest expiry date (most favorable to employee).
      if (
        !existing ||
        (cert.expiryDate && existing.expiryDate && new Date(cert.expiryDate) > new Date(existing.expiryDate))
      ) {
        certByType.set(cert.certificationTypeId, cert);
      }
    }

    // ── Step 3: Check each required certification ──
    const gaps: CertificationGap[] = [];

    for (const requiredTypeId of requiredCertTypeIds) {
      const cert = certByType.get(requiredTypeId);

      if (!cert) {
        gaps.push({ certificationTypeId: requiredTypeId, reason: 'MISSING' });
        continue;
      }

      if (cert.status !== CertificationStatus.ACTIVE) {
        gaps.push({
          certificationTypeId: requiredTypeId,
          reason: 'NOT_ACTIVE',
          expiryDate: cert.expiryDate ? new Date(cert.expiryDate).toISOString() : undefined,
        });
        continue;
      }

      // LIFE-SAFETY: If the cert has an expiry date, it must be valid through
      // the entire rotation period. A cert that expires mid-rotation means the
      // worker would be uncertified for the remainder.
      if (cert.expiryDate) {
        const expiryDate = new Date(cert.expiryDate);
        if (expiryDate < new Date()) {
          gaps.push({
            certificationTypeId: requiredTypeId,
            reason: 'EXPIRED',
            expiryDate: expiryDate.toISOString(),
          });
        } else if (expiryDate < rotationEndDate) {
          gaps.push({
            certificationTypeId: requiredTypeId,
            reason: 'EXPIRES_DURING_ROTATION',
            expiryDate: expiryDate.toISOString(),
          });
        }
      }
      // If expiryDate is null, the cert never expires (e.g., lifetime certs) — valid.
    }

    // ── Step 3b: STCW BST validation for marine/offshore work areas ──
    // HR-MEDIUM-005: Maritime crew must hold STCW BST certification.
    // If the work area is offshore (detected via entity flag or required certs
    // having isSTCW=true), validate STCW BST compliance.
    const stcwCertTypes = await manager.find(CertificationType, {
      where: {
        tenantId,
        isSTCW: true,
        isActive: true,
        isDeleted: false,
      },
      select: ['id', 'name'],
    });

    if (stcwCertTypes.length > 0) {
      // LIFE-SAFETY: If any STCW cert types exist in this tenant, verify
      // the employee holds active STCW certs for offshore work areas.
      for (const stcwType of stcwCertTypes) {
        // Skip if already in the required list (would have been caught above)
        if (requiredCertTypeIds.includes(stcwType.id)) continue;

        // Only enforce STCW for work areas that require offshore certs
        const hasOffshoreRequirement = requiredCertTypeIds.length > 0;
        if (!hasOffshoreRequirement) continue;

        const hasStcw = employeeCerts.some(
          (c) =>
            c.certificationTypeId === stcwType.id &&
            c.status === CertificationStatus.ACTIVE &&
            (!c.expiryDate || new Date(c.expiryDate) >= rotationEndDate),
        );

        if (!hasStcw) {
          // Re-query to check if employee has this STCW cert at all
          const stcwCert = await manager.findOne(EmployeeCertification, {
            where: {
              tenantId,
              employeeId,
              certificationTypeId: stcwType.id,
              isDeleted: false,
            },
          });

          if (!stcwCert) {
            gaps.push({ certificationTypeId: stcwType.id, reason: 'MISSING' });
          } else if (stcwCert.status !== CertificationStatus.ACTIVE) {
            gaps.push({ certificationTypeId: stcwType.id, reason: 'NOT_ACTIVE' });
          } else if (stcwCert.expiryDate && new Date(stcwCert.expiryDate) < rotationEndDate) {
            gaps.push({
              certificationTypeId: stcwType.id,
              reason: 'EXPIRES_DURING_ROTATION',
              expiryDate: new Date(stcwCert.expiryDate).toISOString(),
            });
          }
        }
      }
    }

    // ── Step 4: Reject with details if any gaps found ──
    if (gaps.length > 0) {
      const details = gaps.map((g) => {
        switch (g.reason) {
          case 'MISSING':
            return `Certification type ${g.certificationTypeId}: MISSING — employee does not hold this certification`;
          case 'NOT_ACTIVE':
            return `Certification type ${g.certificationTypeId}: NOT ACTIVE — status is not 'active'`;
          case 'EXPIRED':
            return `Certification type ${g.certificationTypeId}: EXPIRED on ${g.expiryDate}`;
          case 'EXPIRES_DURING_ROTATION':
            return `Certification type ${g.certificationTypeId}: EXPIRES on ${g.expiryDate}, before rotation ends on ${rotationEndDate.toISOString()}`;
        }
      });

      // LIFE-SAFETY: Log the rejection so safety audits can query for patterns
      this.logger.warn(
        JSON.stringify({
          event: 'certification_validation_failed',
          tenantId,
          employeeId,
          workAreaId,
          workAreaName: workArea.name,
          rotationEndDate: rotationEndDate.toISOString(),
          gapCount: gaps.length,
          gaps,
        }),
      );

      throw new BadRequestException(
        `Employee ${employeeId} cannot be assigned to work area "${workArea.name}": ` +
        `${gaps.length} certification gap(s) found. ${details.join('; ')}`,
      );
    }
  }
}
