import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantPrincipal } from './tenant-principal.entity';
import { TenantPrincipalService } from './tenant-principal.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantPrincipal])],
  providers: [TenantPrincipalService],
  exports: [TenantPrincipalService, TypeOrmModule],
})
export class PrincipalModule {}
