import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetCertificationComplianceReportQuery } from '../queries/get-certification-compliance-report.query';
import {
  CertificationType,
  CertificationCategory,
  CertificationRequirement,
} from '../entities/certification-type.entity';
import {
  EmployeeCertification,
  CertificationStatus,
} from '../entities/employee-certification.entity';
import { Employee, EmployeeStatus } from '../../hr/entities/employee.entity';
import {
  CertificationComplianceReport,
  CertificationCategoryCompliance,
} from '../dto/certification-reports.types';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Tenant-wide (optionally department-scoped) certification compliance roll-up.
 *
 * An employee is compliant when they hold an ACTIVE/EXPIRING_SOON certification for
 * every MANDATORY active certification type. Category stats and expiry-horizon
 * counts are derived from the same held-cert set so the headline rate and the
 * breakdown are internally consistent.
 */
@QueryHandler(GetCertificationComplianceReportQuery)
export class GetCertificationComplianceReportHandler
  implements IQueryHandler<GetCertificationComplianceReportQuery>
{
  constructor(
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
    @InjectRepository(EmployeeCertification)
    private readonly certRepository: Repository<EmployeeCertification>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(
    query: GetCertificationComplianceReportQuery,
  ): Promise<CertificationComplianceReport> {
    const { tenantId, departmentId } = query;

    // Active employees in scope.
    const employeeQb = this.employeeRepository
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId', { tenantId })
      .andWhere('e.isDeleted = false')
      .andWhere('e.status = :status', { status: EmployeeStatus.ACTIVE });
    if (departmentId) {
      employeeQb.andWhere('e.departmentHrId = :departmentId', { departmentId });
    }
    const employees = await employeeQb.select(['e.id']).getMany();
    const employeeIds = employees.map((e) => e.id);
    const totalEmployees = employeeIds.length;

    const mandatoryTypes = await this.certTypeRepository.find({
      where: {
        tenantId,
        requirement: CertificationRequirement.MANDATORY,
        isActive: true,
        isDeleted: false,
      },
    });

    // Held certs (ACTIVE/EXPIRING_SOON) for the in-scope employees.
    const heldCerts =
      employeeIds.length === 0
        ? []
        : await this.certRepository
            .createQueryBuilder('ec')
            .where('ec.tenantId = :tenantId', { tenantId })
            .andWhere('ec.employeeId IN (:...employeeIds)', { employeeIds })
            .andWhere('ec.isDeleted = false')
            .andWhere('ec.status IN (:...statuses)', {
              statuses: [
                CertificationStatus.ACTIVE,
                CertificationStatus.EXPIRING_SOON,
              ],
            })
            .getMany();

    // employeeId -> set of held mandatory type ids
    const mandatoryTypeIds = new Set(mandatoryTypes.map((t) => t.id));
    const heldByEmployee = new Map<string, Set<string>>();
    for (const cert of heldCerts) {
      let held = heldByEmployee.get(cert.employeeId);
      if (!held) {
        held = new Set<string>();
        heldByEmployee.set(cert.employeeId, held);
      }
      held.add(cert.certificationTypeId);
    }

    let compliantEmployees = 0;
    if (mandatoryTypeIds.size === 0) {
      // No mandatory certs => everyone is trivially compliant.
      compliantEmployees = totalEmployees;
    } else {
      for (const empId of employeeIds) {
        const held = heldByEmployee.get(empId) ?? new Set<string>();
        const allMet = [...mandatoryTypeIds].every((id) => held.has(id));
        if (allMet) {
          compliantEmployees += 1;
        }
      }
    }

    const nonCompliantEmployees = totalEmployees - compliantEmployees;
    const complianceRate =
      totalEmployees === 0
        ? 0
        : Math.round((compliantEmployees / totalEmployees) * 10000) / 100;

    // Expiry-horizon counts over the held set.
    const now = new Date();
    let expiringWithin30Days = 0;
    let expiringWithin60Days = 0;
    let expiringWithin90Days = 0;
    let expiredCount = 0;

    const certTypeById = new Map(
      (
        await this.certTypeRepository.find({
          where: { tenantId, isDeleted: false },
        })
      ).map((t) => [t.id, t]),
    );

    // Per-category accumulators.
    const categoryCerts = new Map<CertificationCategory, number>();
    const categoryExpiring = new Map<CertificationCategory, number>();

    for (const cert of heldCerts) {
      const type = certTypeById.get(cert.certificationTypeId);
      const category = type?.category ?? CertificationCategory.OTHER;
      categoryCerts.set(category, (categoryCerts.get(category) ?? 0) + 1);

      if (cert.expiryDate) {
        const days = Math.ceil(
          (new Date(cert.expiryDate).getTime() - now.getTime()) / MS_PER_DAY,
        );
        if (days < 0) {
          expiredCount += 1;
        } else if (days <= 30) {
          expiringWithin30Days += 1;
          categoryExpiring.set(category, (categoryExpiring.get(category) ?? 0) + 1);
        } else if (days <= 60) {
          expiringWithin60Days += 1;
          categoryExpiring.set(category, (categoryExpiring.get(category) ?? 0) + 1);
        } else if (days <= 90) {
          expiringWithin90Days += 1;
          categoryExpiring.set(category, (categoryExpiring.get(category) ?? 0) + 1);
        }
      }
    }

    // Per-category compliance: required = mandatory types in that category,
    // certified = distinct (employee, type) held pairs for that category.
    const mandatoryByCategory = new Map<CertificationCategory, CertificationType[]>();
    for (const type of mandatoryTypes) {
      const list = mandatoryByCategory.get(type.category) ?? [];
      list.push(type);
      mandatoryByCategory.set(type.category, list);
    }

    const byCategory: CertificationCategoryCompliance[] = [];
    for (const [category, types] of mandatoryByCategory.entries()) {
      const typeIds = new Set(types.map((t) => t.id));
      const totalRequired = totalEmployees * typeIds.size;
      let totalCertified = 0;
      for (const empId of employeeIds) {
        const held = heldByEmployee.get(empId);
        if (!held) continue;
        for (const id of typeIds) {
          if (held.has(id)) totalCertified += 1;
        }
      }
      byCategory.push({
        category,
        totalRequired,
        totalCertified,
        complianceRate:
          totalRequired === 0
            ? 0
            : Math.round((totalCertified / totalRequired) * 10000) / 100,
        expiringCount: categoryExpiring.get(category) ?? 0,
      });
    }

    return {
      totalEmployees,
      compliantEmployees,
      nonCompliantEmployees,
      complianceRate,
      expiringWithin30Days,
      expiringWithin60Days,
      expiringWithin90Days,
      expiredCount,
      byCategory,
    };
  }
}
