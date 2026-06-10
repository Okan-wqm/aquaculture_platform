import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { PasswordResetController } from './password-reset.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        transport: Transport.NATS,
        options: {
          servers: [process.env['NATS_URL'] ?? 'nats://localhost:4222'],
        },
      },
    ]),
  ],
  controllers: [PasswordResetController],
})
export class PasswordResetModule {}
