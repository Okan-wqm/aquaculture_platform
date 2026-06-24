import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { DatabaseManagementModule } from '../database-management/database-management.module';
import { TenantSchema } from '../database-management/entities/database-management.entity';
import { ModuleAssignmentService } from '../modules/tenant-management/services/module-assignment.service';
import { AdminOutboxModule } from '../outbox/admin-outbox.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';

import {
  TenantActivity,
  TenantNote,
  TenantBillingInfo,
} from './entities/tenant-activity.entity';
import { Tenant, TenantInvitation } from './entities/tenant.entity';
import { TenantErasureOperation } from './entities/tenant-erasure-operation.entity';
import {
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
} from './handlers/suspend-tenant.handler';
import {
  RequestTenantErasureHandler,
  TenantErasureProofHandler,
} from './handlers/tenant-erasure.handler';
import { TenantOnboardingAckHandler } from './handlers/tenant-onboarding-ack.handler';
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
import { AuthTenantProvisioningClientService } from './services/auth-tenant-provisioning-client.service';
import { TenantActivityService } from './services/tenant-activity.service';
import { TenantDetailService } from './services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from './services/tenant-provisioning-workflow.service';
import { TenantProvisioningService } from './services/tenant-provisioning.service';
import { TenantAdminController, TenantPublicController } from './tenant.controller';

const CommandHandlers = [
  UpdateTenantHandler,
  SuspendTenantHandler,
  ActivateTenantHandler,
  DeactivateTenantHandler,
  ArchiveTenantHandler,
  RequestTenantErasureHandler,
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
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
    TypeOrmModule.forFeature([
      Tenant,
      TenantInvitation,
      TenantErasureOperation,
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
    TenantErasureTargetModule.forService('admin-api-service'),
  ],
  controllers: [TenantPublicController, TenantAdminController, TenantOnboardingAckHandler],
  providers: [
    ...CommandHandlers,
    ...QueryHandlers,
    TenantProvisioningService,
    TenantProvisioningWorkflowService,
    AuthTenantProvisioningClientService,
    TenantActivityService,
    TenantDetailService,
    ModuleAssignmentService,
    TenantErasureProofHandler,
  ],
  exports: [
    TenantProvisioningService,
    TenantProvisioningWorkflowService,
    TenantActivityService,
    AuthTenantProvisioningClientService,
  ],
})
export class TenantManagementModule {}
