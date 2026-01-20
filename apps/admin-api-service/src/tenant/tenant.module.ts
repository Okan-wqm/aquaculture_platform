import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { Tenant, TenantInvitation } from './entities/tenant.entity';
import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from './entities/tenant-activity.entity';
import { TenantController } from './tenant.controller';
import { CreateTenantHandler } from './handlers/create-tenant.handler';
import { UpdateTenantHandler } from './handlers/update-tenant.handler';
import {
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
} from './handlers/suspend-tenant.handler';
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
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantDetailService } from './services/tenant-detail.service';
import { ModuleAssignmentService } from '../modules/tenant-management/services/module-assignment.service';
import { AuditLogModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { BillingModule } from '../billing/billing.module';

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
