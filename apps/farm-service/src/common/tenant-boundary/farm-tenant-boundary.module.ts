import { Global, Module } from '@nestjs/common';

import { FarmAiResponder } from './farm-ai-responder';
import { FarmTenantScopes } from './farm-tenant-scopes';

/**
 * farm's tenant data boundary (K10 layer 4): `FarmTenantScopes` for callers
 * that start from a tenant id, `FarmAiResponder` for the AI-facing responders.
 * Global so every domain module's resolvers and responders can inject them.
 */
@Global()
@Module({
  providers: [FarmTenantScopes, FarmAiResponder],
  exports: [FarmTenantScopes, FarmAiResponder],
})
export class FarmTenantBoundaryModule {}
