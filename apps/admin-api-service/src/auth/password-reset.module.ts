import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';

import { PasswordResetController } from './password-reset.controller';

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
  controllers: [PasswordResetController],
})
export class PasswordResetModule {}
