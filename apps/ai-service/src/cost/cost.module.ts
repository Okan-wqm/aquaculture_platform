import { Module } from '@nestjs/common';
import { TokenBudgetService } from './token-budget.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  providers: [TokenBudgetService, RateLimitService],
  exports: [TokenBudgetService, RateLimitService],
})
export class CostModule {}
