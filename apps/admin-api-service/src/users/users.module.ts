import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';

import { SettingsModule } from '../settings/settings.module';
import { AuthCommandClientModule } from '../auth/auth-command-client.module';

import { UserPermissions } from './entities/user-permissions.entity';
import { RoleTemplateService } from './services/role-template.service';
import { UserPermissionsService } from './services/user-permissions.service';
import { UserProvisioningService } from './services/user-provisioning.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';


@Module({
  imports: [
    TypeOrmModule.forFeature([UserPermissions]),
    SettingsModule,
    AuthCommandClientModule,
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
     * Shares the naming convention (`*_NATS_CLIENT`) and factory
     * (`buildNatsTransportOptions`) with `MessagingAdminModule` so all
     * cross-service RPC in admin-api is consistent.
     */
    ClientsModule.register([
      {
        name: 'AUTH_NATS_CLIENT',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('admin-api-service'),
      },
    ]),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserProvisioningService,
    RoleTemplateService,
    UserPermissionsService,
  ],
  exports: [
    UsersService,
    UserProvisioningService,
    RoleTemplateService,
    UserPermissionsService,
  ],
})
export class UsersModule {}
