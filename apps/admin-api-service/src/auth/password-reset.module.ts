import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

import { PasswordResetController } from './password-reset.controller';

@Module({
  imports: [
    // PR-B (PLAT-HIGH-003): migrated to the platform NatsV3Client. This callsite
    // previously used an inline servers-only options object (the platform outlier),
    // which bypassed ADR-015 cert-is-identity. NatsV3Client resolves servers + the
    // mTLS client cert from buildNatsConnectionOptions('admin-api-service'), bringing
    // it in line with the other admin-api-service NATS clients.
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
  ],
  controllers: [PasswordResetController],
})
export class PasswordResetModule {}
