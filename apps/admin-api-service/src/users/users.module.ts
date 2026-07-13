import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

import { SettingsModule } from '../settings/settings.module';

import { RoleTemplateService } from './services/role-template.service';
import { UserProvisioningService } from './services/user-provisioning.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';


@Module({
  imports: [
    SettingsModule,
    /**
     * NATS client for auth-service delegation.
     *
     * Replaces the previous raw-SQL writes from `users.service.ts` against
     * `auth.users` (CRITICAL-001 in
     * `docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md`). The entire
     * point of routing through NATS is to make the User entity on
     * auth-service the SINGLE writer — the `password` column name lives on
     * the entity once, and admin-api never knows or cares what it's called.
     *
     * Shares the naming convention (`*_NATS_CLIENT`) and the platform
     * `NatsV3Client` transport with `MessagingAdminModule` so all
     * cross-service RPC in admin-api is consistent.
     */
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserProvisioningService,
    RoleTemplateService,
  ],
  exports: [
    UsersService,
    UserProvisioningService,
    RoleTemplateService,
  ],
})
export class UsersModule {}
