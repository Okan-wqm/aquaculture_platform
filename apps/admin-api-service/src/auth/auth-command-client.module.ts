import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthCommandClientService } from './auth-command-client.service';

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
  providers: [AuthCommandClientService],
  exports: [ClientsModule, AuthCommandClientService],
})
export class AuthCommandClientModule {}
