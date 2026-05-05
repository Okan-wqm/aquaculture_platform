/**
 * Supplier Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Supplier } from './entities/supplier.entity';
import { SupplierType } from './entities/supplier-type.entity';
import { SupplierSite } from './entities/supplier-site.entity';
import { Site } from '../site/entities/site.entity';

// Resolver
import { SupplierResolver } from './supplier.resolver';

import { RestoreModule } from '../common/services/restore.module';

// Command Handlers
import { CreateSupplierHandler } from './handlers/create-supplier.handler';
import { UpdateSupplierHandler } from './handlers/update-supplier.handler';
import { DeleteSupplierHandler } from './handlers/delete-supplier.handler';
import { SetSupplierApprovedSitesHandler } from './handlers/set-supplier-approved-sites.handler';

// Query Handlers
import { GetSupplierHandler } from './handlers/get-supplier.handler';
import { ListSuppliersHandler } from './handlers/list-suppliers.handler';
import { ListSupplierSitesHandler } from './handlers/list-supplier-sites.handler';

const CommandHandlers = [
  CreateSupplierHandler,
  UpdateSupplierHandler,
  DeleteSupplierHandler,
  SetSupplierApprovedSitesHandler,
];

const QueryHandlers = [
  GetSupplierHandler,
  ListSuppliersHandler,
  ListSupplierSitesHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Supplier, SupplierType, SupplierSite, Site]),
    RestoreModule,
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
