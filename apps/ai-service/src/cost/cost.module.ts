import { Module } from '@nestjs/common';
import { TokenBudgetService } from './token-budget.service';
import { RateLimitService } from './rate-limit.service';

/**
 * Cost management module — rate limiting and token budget tracking.
 *
 * Both services accept RedisService via @Optional() injection.
 * When RedisModule is imported in AppModule (production), counters
 * are distributed across instances. Without Redis, they fall back
 * to in-memory Maps (single-instance only).
 */
@Module({
  providers: [TokenBudgetService, RateLimitService],
  exports: [TokenBudgetService, RateLimitService],
})
export class CostModule {}
