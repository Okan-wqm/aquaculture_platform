/**
 * Get Equipment Types Query Handler
 *
 * Reads the PER-TENANT equipment_types catalog (operator decision). equipment_types
 * is cloned into each tenant schema, and the resolver no longer carries
 * @SkipTenantGuard, so this runs tenant-scoped: the repository reads the requesting
 * tenant's rows via search_path (tenant_<uuid>).
 *
 * PERF(F3-001): direct ID lookup avoids a full-table-scan + JS filter.
 *
 * NOTE: a previous in-process Map cache (keyed by the serialized FILTER ONLY) was a
 * CROSS-TENANT LEAK — it was process-wide and tenant-blind, so the first tenant's
 * result was served to every other tenant. It is removed: equipment_types is small
 * reference data and React Query already caches it per-tenant on the client
 * (useEquipmentTypes uses a tenant-scoped query key).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetEquipmentTypesQuery } from '../queries/get-equipment-types.query';
import { EquipmentType } from '../entities/equipment-type.entity';

@QueryHandler(GetEquipmentTypesQuery)
export class GetEquipmentTypesHandler implements IQueryHandler<GetEquipmentTypesQuery> {
  constructor(
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  async execute(query: GetEquipmentTypesQuery): Promise<EquipmentType[]> {
    const { filter } = query;

    // PERF(F3-001): direct ID lookup — bypass the list path for a single record.
    if (filter?.id) {
      const byId = this.equipmentTypeRepository.createQueryBuilder('equipmentType');
      byId.where('equipmentType.id = :id', { id: filter.id });
      if (filter.isActive !== undefined) {
        byId.andWhere('equipmentType.isActive = :isActive', { isActive: filter.isActive });
      }
      const result = await byId.getOne();
      return result ? [result] : [];
    }

    const queryBuilder = this.equipmentTypeRepository.createQueryBuilder('equipmentType');

    if (filter?.category) {
      queryBuilder.where('equipmentType.category = :category', { category: filter.category });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('equipmentType.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(equipmentType.name ILIKE :search OR equipmentType.code ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    queryBuilder.orderBy('equipmentType.category', 'ASC');
    queryBuilder.addOrderBy('equipmentType.name', 'ASC');

    return queryBuilder.getMany();
  }
}
