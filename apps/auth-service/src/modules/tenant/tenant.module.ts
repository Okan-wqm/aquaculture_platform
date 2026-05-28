import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { EventBusModule } from '@platform/event-bus';

import { Invitation } from '../authentication/entities/invitation.entity';
import { RefreshToken } from '../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../authentication/entities/user-module-assignment.entity';
import { User } from '../authentication/entities/user.entity';
import { Module as SystemModule } from '../system-module/entities/module.entity';

import { MobileUserSettings } from './entities/mobile-user-settings.entity';
import { TenantModule as TenantModuleEntity } from './entities/tenant-module.entity';
import { Tenant } from './entities/tenant.entity';
import { AuthAdminNatsHandler } from './handlers/auth-admin-nats.handler';
import { AuthUserQueryNatsHandler } from './handlers/auth-user-query-nats.handler';
import { MobileSettingsResolver } from './resolvers/mobile-settings.resolver';
import { TenantAdminResolver } from './resolvers/tenant-admin.resolver';
import { TenantRoleResolver } from './resolvers/tenant-role.resolver';
import { TenantResolver } from './resolvers/tenant.resolver';
import { MobileSettingsService } from './services/mobile-settings.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantRoleService } from './services/tenant-role.service';
import { TenantUserManagementService } from './services/tenant-user-management.service';
import { TenantService } from './services/tenant.service';
import { TenantUserCountReconcileService } from './services/tenant-user-count-reconcile.service';
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
      Invitation,
    ]),
    EventBusModule,
  ],
  // AuthAdminNatsHandler is declared in `controllers` (not `providers`) —
  // NestJS microservice transport discovers @MessagePattern subscribers by
  // scanning `controllers`. Declaring it as a provider would make the DI
  // container happy but the NATS subscriber would never register.
  controllers: [AuthAdminNatsHandler, AuthUserQueryNatsHandler],
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
    // DBR-LOW-001 cure: daily 04:00 UTC reconcile of
    // auth.tenants.userCount vs auth.users count. Catches drift from
    // edge cases (transaction rollback, manual DB intervention,
    // hard-erasure paths) that bypass the application-side
    // increment/decrement. Replace-with-computed semantics, NOT
    // delta — single drift ring doesn't propagate forward.
    TenantUserCountReconcileService,
  ],
  exports: [TenantService, TenantAdminService, TenantRoleService, UserLifecycleService, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TenantModule {}
