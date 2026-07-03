/**
 * Get Supplier Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSupplierQuery } from '../queries/get-supplier.query';
import { Supplier } from '../entities/supplier.entity';

@QueryHandler(GetSupplierQuery)
export class GetSupplierHandler implements IQueryHandler<GetSupplierQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSupplierQuery): Promise<Supplier> {
    const { supplierId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const supplier = await queryRunner.manager.findOne(Supplier, {
        where: { id: supplierId, tenantId },
      });

      if (!supplier) {
        throw new NotFoundException(`Supplier with ID "${supplierId}" not found`);
      }

      return supplier;
    });
  }
}
