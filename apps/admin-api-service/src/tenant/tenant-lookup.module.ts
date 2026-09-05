/**
 * TenantLookupModule — admin-api's binding of the kernel `TENANT_ACTIVE_CHECK`
 * port (ADMIN-CRITICAL-009).
 *
 * `@TenantParam()` resolves every client-supplied tenant id through
 * `VerifiedTenantPipe`, which reads this port. admin-api reads the
 * authoritative tenant record (`auth.tenants`, D14 — auth-service is the
 * single writer, admin only reads) through its read-only mapping of the
 * entity. Global, because the pipe is instantiated in whichever feature
 * module hosts the controller and must find the port there.
 */
import {
  TENANT_ACTIVE_CHECK,
  type TenantActiveCheck,
} from '@aquaculture/backend-common/middleware';
import { VerifiedTenantPipe } from '@aquaculture/backend-common/tenant';
import { Global, Injectable, Module } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import type { TenantStatus } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Tenant } from './entities/tenant.entity';

@Injectable()
export class TenantLookupService implements TenantActiveCheck {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  async lookupTenant(tenantId: string): Promise<{ status: TenantStatus } | null> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, status: true },
    });
    return tenant ? { status: tenant.status } : null;
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Tenant])],
  providers: [
    TenantLookupService,
    { provide: TENANT_ACTIVE_CHECK, useExisting: TenantLookupService },
    VerifiedTenantPipe,
  ],
  exports: [TenantLookupService, TENANT_ACTIVE_CHECK, VerifiedTenantPipe],
})
export class TenantLookupModule {}
