import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { ModuleAssignmentService } from '../modules/tenant-management/services/module-assignment.service';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';

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
    ]),
    CqrsModule,
    AuditLogModule,
    SettingsModule,
    BillingModule,
    UsersModule,
  ],
  controllers: [TenantController],
  providers: [
    ...CommandHandlers,
    ...QueryHandlers,
    TenantProvisioningService,
    TenantActivityService,
    TenantDetailService,
    ModuleAssignmentService,
  ],
  exports: [TenantProvisioningService, TenantActivityService],
})
export class TenantManagementModule {}
