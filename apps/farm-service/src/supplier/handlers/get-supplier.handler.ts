/**
 * Get Supplier Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetSupplierQuery } from '../queries/get-supplier.query';
import { Supplier } from '../entities/supplier.entity';

@QueryHandler(GetSupplierQuery)
export class GetSupplierHandler implements IQueryHandler<GetSupplierQuery> {
  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(query: GetSupplierQuery): Promise<Supplier> {
    const { supplierId, tenantId } = query;

    const supplier = await this.supplierRepository.findOne({
      where: { id: supplierId, tenantId },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier with ID "${supplierId}" not found`);
    }

    return supplier;
  }
}
