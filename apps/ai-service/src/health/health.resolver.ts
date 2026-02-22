import { Resolver, Query } from '@nestjs/graphql';
import { Public, SkipTenantGuard } from '@platform/backend-common';

@Resolver()
@Public()
@SkipTenantGuard()
export class HealthResolver {
  @Query(() => String, { description: 'Health check for AI service' })
  aiServiceHealth(): string {
    return 'ok';
  }
}
