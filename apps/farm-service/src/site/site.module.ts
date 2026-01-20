/**
 * Site Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entity
import { Site } from './entities/site.entity';
import { Department } from '../department/entities/department.entity';
import { System } from '../system/entities/system.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { Tank } from '../tank/entities/tank.entity';

// Resolver
import { SiteResolver } from './site.resolver';

// Command Handlers
import { CreateSiteHandler } from './handlers/create-site.handler';
import { UpdateSiteHandler } from './handlers/update-site.handler';
import { DeleteSiteHandler } from './handlers/delete-site.handler';

// Query Handlers
import { GetSiteHandler } from './handlers/get-site.handler';
import { ListSitesHandler } from './handlers/list-sites.handler';
import { GetSiteDeletePreviewHandler } from './handlers/get-site-delete-preview.handler';

const CommandHandlers = [
  CreateSiteHandler,
  UpdateSiteHandler,
  DeleteSiteHandler,
];

const QueryHandlers = [
  GetSiteHandler,
  ListSitesHandler,
  GetSiteDeletePreviewHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Site, Department, System, Equipment, Tank]),
    CqrsModule,
  ],
  providers: [
    SiteResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class SiteModule {}
