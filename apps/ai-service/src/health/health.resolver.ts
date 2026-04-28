import { Resolver, Query } from '@nestjs/graphql';
import { Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';

@Resolver()
@Public()
@SkipTenantGuard()
export class HealthResolver {
  @Query(() => String, { description: 'Health check for AI service' })
  aiServiceHealth(): string {
    return 'ok';
  }
}
