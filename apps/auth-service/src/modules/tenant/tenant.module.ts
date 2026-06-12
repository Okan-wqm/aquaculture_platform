import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActionToken } from '../authentication/entities/action-token.entity';
import { Invitation } from '../authentication/entities/invitation.entity';
import { RefreshToken } from '../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../authentication/entities/user-module-assignment.entity';
import { User } from '../authentication/entities/user.entity';
import { Module as SystemModule } from '../system-module/entities/module.entity';

import { MobileUserSettings } from './entities/mobile-user-settings.entity';
import { TenantModule as TenantModuleEntity } from './entities/tenant-module.entity';
import { Tenant } from './entities/tenant.entity';
import { TenantSubscriptionProjectionHandler } from './event-handlers/tenant-subscription-projection.handler';
import { AuthAdminNatsHandler } from './handlers/auth-admin-nats.handler';
import { MobileSettingsResolver } from './resolvers/mobile-settings.resolver';
import { TenantAdminResolver } from './resolvers/tenant-admin.resolver';
import { TenantRoleResolver } from './resolvers/tenant-role.resolver';
import { TenantResolver } from './resolvers/tenant.resolver';
import { MobileSettingsService } from './services/mobile-settings.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantProvisioningCommandService } from './services/tenant-provisioning-command.service';
import { TenantRoleService } from './services/tenant-role.service';
import { TenantUserCountReconcileService } from './services/tenant-user-count-reconcile.service';
import { TenantUserManagementService } from './services/tenant-user-management.service';
import { TenantService } from './services/tenant.service';
import { UserLifecycleService } from './services/user-lifecycle.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantModuleEntity,
      User,
      ActionToken,
      UserModuleAssignment,
      SystemModule,
      MobileUserSettings,
      RefreshToken,
      Invitation,
    ]),
  ],
  // AuthAdminNatsHandler is declared in `controllers` (not `providers`) —
  // NestJS microservice transport discovers @MessagePattern subscribers by
  // scanning `controllers`. Declaring it as a provider would make the DI
  // container happy but the NATS subscriber would never register.
  controllers: [AuthAdminNatsHandler],
  providers: [
    TenantService,
    TenantAdminService,
    TenantRoleService,
    TenantUserManagementService,
    UserLifecycleService,
    TenantProvisioningCommandService,
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
    // DATA-LOW-001: projects billing.subscriptions state (the SSoT) onto the
    // auth.tenants subscription columns via the TenantSubscriptionChanged event.
    TenantSubscriptionProjectionHandler,
  ],
  exports: [TenantService, TenantAdminService, TenantRoleService, UserLifecycleService, TypeOrmModule],
})
export class TenantModule {
  private readonly moduleClass = TenantModule.name;
}
