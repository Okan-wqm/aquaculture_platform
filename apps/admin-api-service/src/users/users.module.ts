import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserProvisioningService } from './services/user-provisioning.service';
import { RoleTemplateService } from './services/role-template.service';
import { UserPermissionsService } from './services/user-permissions.service';
import { UserPermissions } from './entities/user-permissions.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserPermissions])],
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
