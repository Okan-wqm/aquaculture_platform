import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { MessagingCommandClientService } from './messaging-command-client.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'MESSAGING_NATS_CLIENT',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('admin-api-service'),
      },
    ]),
  ],
  providers: [MessagingCommandClientService],
  exports: [ClientsModule, MessagingCommandClientService],
})
export class MessagingCommandClientModule {}
