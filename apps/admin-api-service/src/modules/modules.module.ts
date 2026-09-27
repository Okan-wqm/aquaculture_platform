import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { TenantManagementModule } from '../tenant/tenant.module';

import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  imports: [
    // AuthTenantProvisioningClientService is the ONE instance TenantManagementModule
    // provides and exports; listing it under `providers` here built a second
    // one (tests/invariants/nest-module-provider-duplication.spec.ts).
    TenantManagementModule,
    // ModulesService also drives the raw auth NATS client directly.
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
  ],
  controllers: [ModulesController],
  providers: [ModulesService],
  exports: [ModulesService],
})
export class SystemModulesModule {}
