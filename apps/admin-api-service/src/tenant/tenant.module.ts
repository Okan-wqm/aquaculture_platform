import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DatabaseManagementModule } from '../database-management/database-management.module';
import { TenantSchema } from '../database-management/entities/database-management.entity';
import { ModuleAssignmentService } from '../modules/tenant-management/services/module-assignment.service';
import { AdminOutboxModule } from '../outbox/admin-outbox.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { AuthCommandClientModule } from '../auth/auth-command-client.module';
import { MessagingCommandClientModule } from '../messaging/messaging-command-client.module';

import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from './entities/tenant-activity.entity';
import { Tenant, TenantInvitation } from './entities/tenant.entity';
import { CreateTenantHandler } from './handlers/create-tenant.handler';
import {
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
} from './handlers/suspend-tenant.handler';
import { UpdateTenantHandler } from './handlers/update-tenant.handler';
import {
  GetTenantByIdHandler,
  GetTenantBySlugHandler,
  ListTenantsHandler,
  GetTenantStatsHandler,
  GetTenantUsageHandler,
  GetTenantsApproachingLimitsHandler,
  GetExpiringTrialsHandler,
  SearchTenantsHandler,
} from './query-handlers/tenant-query.handlers';
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantDetailService } from './services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from './services/tenant-provisioning-workflow.service';
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { TenantController } from './tenant.controller';

const CommandHandlers = [
  CreateTenantHandler,
  UpdateTenantHandler,
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
];

const QueryHandlers = [
  GetTenantByIdHandler,
  GetTenantBySlugHandler,
  ListTenantsHandler,
  GetTenantStatsHandler,
  GetTenantUsageHandler,
  GetTenantsApproachingLimitsHandler,
  GetExpiringTrialsHandler,
  SearchTenantsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantInvitation,
      TenantActivity,
      TenantNote,
      TenantBillingInfo,
      TenantSchema,
    ]),
    AuditLogModule,
    DatabaseManagementModule,
    SettingsModule,
    BillingModule,
    UsersModule,
    AdminOutboxModule,
    AuthCommandClientModule,
    MessagingCommandClientModule,
  ],
  controllers: [TenantController],
  providers: [
    ...CommandHandlers,
    ...QueryHandlers,
    TenantProvisioningService,
    TenantProvisioningWorkflowService,
    TenantActivityService,
    TenantDetailService,
    ModuleAssignmentService,
  ],
  exports: [TenantProvisioningService, TenantProvisioningWorkflowService, TenantActivityService],
})
export class TenantManagementModule {}
