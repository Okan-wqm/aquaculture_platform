import {
  Tenant as CurrentTenant,
  TenantAdminOrHigher,
} from '@aquaculture/backend-common/decorators';
import { Query, Resolver } from '@nestjs/graphql';

import { ModuleAccessReadinessView } from '../dto/module-access-readiness.dto';
import { ModuleAccessReadinessService } from '../services/module-access-readiness.service';

/**
 * Module-access readiness (PKG-06; plan §6 R4 entry gate): counts only, for the caller's own
 * tenant — from the verified claim, never an argument — and for a tenant administrator, who is
 * the one to grant what the counts show missing (setUserModuleAccess).
 */
@Resolver()
export class ModuleAccessReadinessResolver {
  constructor(private readonly readiness: ModuleAccessReadinessService) {}

  @Query(() => ModuleAccessReadinessView)
  @TenantAdminOrHigher()
  async moduleAccessReadiness(
    @CurrentTenant() tenantId: string,
  ): Promise<ModuleAccessReadinessView> {
    return ModuleAccessReadinessView.of(await this.readiness.readiness(tenantId));
  }
}
