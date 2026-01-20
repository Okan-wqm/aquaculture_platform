import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from './entities/tenant.entity';
import { TenantModule as TenantModuleEntity } from './entities/tenant-module.entity';
import { TenantService } from './services/tenant.service';
import { TenantAdminService } from './services/tenant-admin.service';
import { TenantResolver } from './resolvers/tenant.resolver';
import { TenantAdminResolver } from './resolvers/tenant-admin.resolver';
import { EventBusModule } from '@platform/event-bus';
import { User } from '../authentication/entities/user.entity';
import { UserModuleAssignment } from '../authentication/entities/user-module-assignment.entity';
import { Module as SystemModule } from '../system-module/entities/module.entity';
import { SchemaManagerService } from '@platform/backend-common';

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
