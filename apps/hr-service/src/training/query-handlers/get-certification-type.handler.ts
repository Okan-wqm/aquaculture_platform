import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetCertificationTypeQuery } from '../queries/get-certification-type.query';
import { CertificationType } from '../entities/certification-type.entity';

@QueryHandler(GetCertificationTypeQuery)
export class GetCertificationTypeHandler
  implements IQueryHandler<GetCertificationTypeQuery>
{
  constructor(
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
  ) {}

  async execute(query: GetCertificationTypeQuery): Promise<CertificationType> {
    const { tenantId, id } = query;

    const certType = await this.certTypeRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });

    if (!certType) {
      throw new NotFoundException(`Certification type with ID ${id} not found`);
    }

    // Resolve prerequisite certification types (id -> {id,code,name,...}) so the
    // FE detail view can render them. prerequisiteCertifications holds the ids.
    const prereqIds = certType.prerequisiteCertifications ?? [];
    if (prereqIds.length > 0) {
      certType.prerequisites = await this.certTypeRepository.find({
        where: { tenantId, id: In(prereqIds), isDeleted: false },
      });
    } else {
      certType.prerequisites = [];
    }

    return certType;
  }
}
