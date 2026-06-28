import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { GetWorkAreaQuery } from '../queries/get-work-area.query';
import { WorkArea } from '../entities/work-area.entity';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { CertificationType } from '../../training/entities/certification-type.entity';
import { WorkAreaDetail, WorkAreaAssignedEmployee } from '../dto/work-area-detail.dto';

/**
 * Single work-area read. Mirrors GetWorkAreasHandler tenant scoping (explicit
 * `tenantId` predicate, isDeleted filter) and additionally resolves the two
 * relations the detail view needs:
 *   - requiredCertifications: scalar cert-type IDs -> CertificationType rows.
 *   - currentAssignments: employees with an IN_PROGRESS rotation in this area.
 */
@QueryHandler(GetWorkAreaQuery)
export class GetWorkAreaHandler implements IQueryHandler<GetWorkAreaQuery> {
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
    @InjectRepository(CertificationType)
    private readonly certificationTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(query: GetWorkAreaQuery): Promise<WorkAreaDetail> {
    const { tenantId, id } = query;

    const workArea = await this.workAreaRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });

    if (!workArea) {
      throw new NotFoundException(`Work area not found: ${id}`);
    }

    // Resolve required certification type IDs to their full records.
    let requiredCertifications: CertificationType[] = [];
    if (workArea.requiredCertifications && workArea.requiredCertifications.length > 0) {
      requiredCertifications = await this.certificationTypeRepository.find({
        where: {
          tenantId,
          id: In(workArea.requiredCertifications),
          isDeleted: false,
        },
      });
    }

    // Resolve current assignments: employees with an in-progress rotation here.
    const activeRotations = await this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.workAreaId = :workAreaId', { workAreaId: id })
      .andWhere('wr.status = :status', { status: RotationStatus.IN_PROGRESS })
      .andWhere('wr.isDeleted = false')
      .getMany();

    const seen = new Set<string>();
    const currentAssignments: WorkAreaAssignedEmployee[] = [];
    for (const rotation of activeRotations) {
      const employee = rotation.employee;
      if (!employee || employee.isDeleted || seen.has(employee.id)) {
        continue;
      }
      seen.add(employee.id);
      currentAssignments.push({
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        // avatarUrl: no employee photo column exists on the Employee entity yet,
        // so this stays undefined rather than fabricating a value.
        avatarUrl: undefined,
      });
    }

    // Strip the scalar `requiredCertifications` (cert-type IDs) off the entity
    // so it does not collide with the resolved CertificationType[] field on the
    // detail type, then overlay the resolved relations.
    const { requiredCertifications: _certIds, ...workAreaBase } = workArea;
    const detail = Object.assign(new WorkAreaDetail(), workAreaBase);
    detail.requiredCertifications = requiredCertifications;
    detail.currentAssignments = currentAssignments;
    return detail;
  }
}
