import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchemaManagerService } from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';

import { UserModuleAssignment } from '../authentication/entities/user-module-assignment.entity';
import { User } from '../authentication/entities/user.entity';
import { Module as SystemModule } from '../system-module/entities/module.entity';

import { TenantModule as TenantModuleEntity } from './entities/tenant-module.entity';
import { Tenant } from './entities/tenant.entity';
import { TenantAdminResolver } from './resolvers/tenant-admin.resolver';
import { TenantResolver } from './resolvers/tenant.resolver';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantService } from './services/tenant.service';




@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantModuleEntity,
      User,
      UserModuleAssignment,
      SystemModule,
    ]),
    EventBusModule,
  ],
  providers: [
    TenantService,
    TenantAdminService,
    TenantResolver,
    TenantAdminResolver,
    SchemaManagerService,
  ],
  exports: [TenantService, TenantAdminService, TypeOrmModule],
})
export class TenantModule {}
