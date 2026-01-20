/**
 * Chemical Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Chemical } from './entities/chemical.entity';
import { ChemicalType } from './entities/chemical-type.entity';
import { ChemicalSite } from './entities/chemical-site.entity';
import { Supplier } from '../supplier/entities/supplier.entity';
import { Site } from '../site/entities/site.entity';

// Resolver
import { ChemicalResolver } from './chemical.resolver';

// Command Handlers
import { CreateChemicalHandler } from './handlers/create-chemical.handler';
import { UpdateChemicalHandler } from './handlers/update-chemical.handler';
import { DeleteChemicalHandler } from './handlers/delete-chemical.handler';
import { AddDocumentHandler } from './handlers/add-document.handler';
import { RemoveDocumentHandler } from './handlers/remove-document.handler';

// Query Handlers
import { GetChemicalHandler } from './handlers/get-chemical.handler';
import { ListChemicalsHandler } from './handlers/list-chemicals.handler';

const CommandHandlers = [
  CreateChemicalHandler,
  UpdateChemicalHandler,
  DeleteChemicalHandler,
  AddDocumentHandler,
  RemoveDocumentHandler,
];

const QueryHandlers = [
  GetChemicalHandler,
  ListChemicalsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Chemical, ChemicalType, ChemicalSite, Supplier, Site]),
    CqrsModule,
  ],
  providers: [
    ChemicalResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class ChemicalModule {}
