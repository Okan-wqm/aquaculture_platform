/**
 * Site Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RestoreModule } from '../common/services/restore.module';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

// Entity
import { Site } from './entities/site.entity';
import { SiteContact } from './entities/site-contact.entity';
import { Department } from '../department/entities/department.entity';
import { System } from '../system/entities/system.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../equipment/entities/equipment-system.entity';
import { Tank } from '../tank/entities/tank.entity';

// Resolver
import { SiteResolver } from './site.resolver';
import { ValidateSiteAssignmentResponder } from './responders/validate-site-assignment.responder';

// Command Handlers
import { CreateSiteHandler } from './handlers/create-site.handler';
import { UpdateSiteHandler } from './handlers/update-site.handler';
import { DeleteSiteHandler } from './handlers/delete-site.handler';
import { UpsertSiteContactsHandler } from './handlers/upsert-site-contacts.handler';

// Query Handlers
import { GetSiteHandler } from './handlers/get-site.handler';
import { GetActiveSiteAccessCatalogHandler } from './handlers/get-active-site-access-catalog.handler';
import { ListSitesHandler } from './handlers/list-sites.handler';
import { GetSiteDeletePreviewHandler } from './handlers/get-site-delete-preview.handler';
import { ListSiteContactsHandler } from './handlers/list-site-contacts.handler';

const CommandHandlers = [
  CreateSiteHandler,
  UpdateSiteHandler,
  DeleteSiteHandler,
  UpsertSiteContactsHandler,
];

const QueryHandlers = [
  GetActiveSiteAccessCatalogHandler,
  GetSiteHandler,
  ListSitesHandler,
  GetSiteDeletePreviewHandler,
  ListSiteContactsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Site,
      SiteContact,
      Department,
      System,
      Equipment,
      EquipmentSystem,
      Tank,
    ]),
    // Phase 4.2: restoreSite mutation delegates to RestoreService.
    RestoreModule,
  ],
  providers: [
    SiteAuthorizationService,
    SiteResolver,
    ValidateSiteAssignmentResponder,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class SiteModule {}
