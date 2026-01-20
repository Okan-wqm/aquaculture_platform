import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserProvisioningService } from './services/user-provisioning.service';
import { RoleTemplateService } from './services/role-template.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UserProvisioningService, RoleTemplateService],
  exports: [UsersService, UserProvisioningService, RoleTemplateService],
})
export class UsersModule {}
