import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetEmployeeCertificationStatusQuery } from '../queries/get-employee-certification-status.query';
import {
  CertificationType,
  CertificationRequirement,
} from '../entities/certification-type.entity';
import {
  EmployeeCertification,
  CertificationStatus,
} from '../entities/employee-certification.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { EmployeeCertificationStatus } from '../dto/certification-reports.types';

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const EXPIRING_SOON_WINDOW_DAYS = 90;

/**
 * Computes an employee's certification compliance snapshot:
 *  - required = all MANDATORY active certification types for the tenant
 *  - held     = employee's ACTIVE / EXPIRING_SOON certifications
 *  - missing  = mandatory types the employee does not hold an active cert for
 *  - expiringSoon = held certs whose expiry is within the next 90 days
 *  - isFullyCompliant = no missing mandatory certs
 */
@QueryHandler(GetEmployeeCertificationStatusQuery)
export class GetEmployeeCertificationStatusHandler
  implements IQueryHandler<GetEmployeeCertificationStatusQuery>
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
    query: GetEmployeeCertificationStatusQuery,
  ): Promise<EmployeeCertificationStatus> {
    const { tenantId, employeeId } = query;

    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
      select: ['id'],
    });
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const mandatoryTypes = await this.certTypeRepository.find({
      where: {
        tenantId,
        requirement: CertificationRequirement.MANDATORY,
        isActive: true,
        isDeleted: false,
      },
    });

    // Held = ACTIVE or EXPIRING_SOON (still valid) certifications.
    const heldCerts = await this.certRepository
      .createQueryBuilder('ec')
      .leftJoinAndSelect('ec.certificationType', 'certificationType')
      .where('ec.tenantId = :tenantId', { tenantId })
      .andWhere('ec.employeeId = :employeeId', { employeeId })
      .andWhere('ec.isDeleted = false')
      .andWhere('ec.status IN (:...statuses)', {
        statuses: [CertificationStatus.ACTIVE, CertificationStatus.EXPIRING_SOON],
      })
      .getMany();

    const heldTypeIds = new Set(heldCerts.map((c) => c.certificationTypeId));

    const missing = mandatoryTypes
      .filter((t) => !heldTypeIds.has(t.id))
      .map((t) => ({
        certificationTypeId: t.id,
        certificationTypeName: t.name,
        category: t.category,
        isMandatory: true,
        requiredForOffshore: t.isOffshoreRequired,
      }));

    const now = new Date();
    const expiringSoon = heldCerts
      .filter((c) => c.expiryDate)
      .map((c) => {
        const expiry = new Date(c.expiryDate!);
        const daysUntilExpiry = Math.ceil(
          (expiry.getTime() - now.getTime()) / MS_PER_DAY,
        );
        return { cert: c, expiry, daysUntilExpiry };
      })
      .filter(
        ({ daysUntilExpiry }) =>
          daysUntilExpiry >= 0 && daysUntilExpiry <= EXPIRING_SOON_WINDOW_DAYS,
      )
      .map(({ cert, expiry, daysUntilExpiry }) => ({
        certificationTypeId: cert.certificationTypeId,
        certificationTypeName: cert.certificationType?.name ?? 'Unknown',
        expiryDate: expiry.toISOString(),
        daysUntilExpiry,
      }));

    return {
      isFullyCompliant: missing.length === 0,
      totalRequired: mandatoryTypes.length,
      totalHeld: heldTypeIds.size,
      expiringSoon,
      missing,
    };
  }
}
