import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchemaManagerService } from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';

import { RefreshToken } from '../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../authentication/entities/user-module-assignment.entity';
import { User } from '../authentication/entities/user.entity';
import { Module as SystemModule } from '../system-module/entities/module.entity';

import { MobileUserSettings } from './entities/mobile-user-settings.entity';
import { TenantModule as TenantModuleEntity } from './entities/tenant-module.entity';
import { Tenant } from './entities/tenant.entity';
import { MobileSettingsResolver } from './resolvers/mobile-settings.resolver';
import { TenantAdminResolver } from './resolvers/tenant-admin.resolver';
import { TenantResolver } from './resolvers/tenant.resolver';
import { MobileSettingsService } from './services/mobile-settings.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantService } from './services/tenant.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantModuleEntity,
      User,
      UserModuleAssignment,
      SystemModule,
      MobileUserSettings,
      RefreshToken,
    ]),
    EventBusModule,
  ],
  providers: [
    TenantService,
    TenantAdminService,
    MobileSettingsService,
    TenantResolver,
    TenantAdminResolver,
    MobileSettingsResolver,
    SchemaManagerService,
  ],
  exports: [TenantService, TenantAdminService, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TenantModule {}
