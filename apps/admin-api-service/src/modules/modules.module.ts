import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthTenantProvisioningClientService } from '../tenant/services/auth-tenant-provisioning-client.service';

import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('admin-api-service'),
      },
    ]),
  ],
  controllers: [ModulesController],
  providers: [ModulesService, AuthTenantProvisioningClientService],
  exports: [ModulesService],
})
export class SystemModulesModule {}
