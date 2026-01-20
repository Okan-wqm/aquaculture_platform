/**
 * Supplier Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Supplier } from './entities/supplier.entity';
import { SupplierType } from './entities/supplier-type.entity';

// Resolver
import { SupplierResolver } from './supplier.resolver';

// Command Handlers
import { CreateSupplierHandler } from './handlers/create-supplier.handler';
import { UpdateSupplierHandler } from './handlers/update-supplier.handler';
import { DeleteSupplierHandler } from './handlers/delete-supplier.handler';

// Query Handlers
import { GetSupplierHandler } from './handlers/get-supplier.handler';
import { ListSuppliersHandler } from './handlers/list-suppliers.handler';

const CommandHandlers = [
  CreateSupplierHandler,
  UpdateSupplierHandler,
  DeleteSupplierHandler,
];

const QueryHandlers = [
  GetSupplierHandler,
  ListSuppliersHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Supplier, SupplierType]),
    CqrsModule,
  ],
  providers: [
    SupplierResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class SupplierModule {}
