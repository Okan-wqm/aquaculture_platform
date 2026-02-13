import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SettingsModule } from '../settings/settings.module';

import { UserPermissions } from './entities/user-permissions.entity';
import { RoleTemplateService } from './services/role-template.service';
import { UserPermissionsService } from './services/user-permissions.service';
import { UserProvisioningService } from './services/user-provisioning.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';


@Module({
  imports: [TypeOrmModule.forFeature([UserPermissions]), SettingsModule],
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
