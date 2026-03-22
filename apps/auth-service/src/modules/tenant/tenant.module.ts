import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchemaManagerService } from '@aquaculture/backend-common';
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
import { TenantRoleResolver } from './resolvers/tenant-role.resolver';
import { TenantResolver } from './resolvers/tenant.resolver';
import { MobileSettingsService } from './services/mobile-settings.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantRoleService } from './services/tenant-role.service';
import { TenantUserManagementService } from './services/tenant-user-management.service';
import { TenantService } from './services/tenant.service';
import { UserLifecycleService } from './services/user-lifecycle.service';

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
    TenantRoleService,
    TenantUserManagementService,
    UserLifecycleService,
    MobileSettingsService,
    TenantResolver,
    TenantAdminResolver,
    TenantRoleResolver,
    MobileSettingsResolver,
    SchemaManagerService,
  ],
  exports: [TenantService, TenantAdminService, TenantRoleService, UserLifecycleService, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TenantModule {}
