import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetCertificationsForWorkAreaQuery } from '../queries/get-certifications-for-work-area.query';
import { CertificationType } from '../entities/certification-type.entity';
import { WorkArea } from '../../aquaculture/entities/work-area.entity';

/**
 * Returns the certification types required to work in a given work area.
 *
 * A work area declares its required certifications via WorkArea.requiredCertifications
 * (an array of CertificationType ids). This query resolves those ids to the full
 * CertificationType rows, tenant-scoped.
 */
@QueryHandler(GetCertificationsForWorkAreaQuery)
export class GetCertificationsForWorkAreaHandler
  implements IQueryHandler<GetCertificationsForWorkAreaQuery>
{
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(
    query: GetCertificationsForWorkAreaQuery,
  ): Promise<CertificationType[]> {
    const { tenantId, workAreaId } = query;

    const workArea = await this.workAreaRepository.findOne({
      where: { id: workAreaId, tenantId, isDeleted: false },
    });

    if (!workArea) {
      throw new NotFoundException(`Work area with ID ${workAreaId} not found`);
    }

    const requiredIds = workArea.requiredCertifications ?? [];
    if (requiredIds.length === 0) {
      return [];
    }

    return this.certTypeRepository.find({
      where: { tenantId, id: In(requiredIds), isDeleted: false },
      order: { displayOrder: 'ASC', name: 'ASC' },
    });
  }
}
