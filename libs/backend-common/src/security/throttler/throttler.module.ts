import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RATE_LIMITER_STRATEGY } from '../interfaces';

import { IpRateLimiterService } from './ip-rate-limiter.service';
import { SlidingWindowStrategy } from './sliding-window.strategy';
import { ThrottlerGuard } from './throttler.guard';

/**
 * Throttler Module
 *
 * Provides rate limiting capabilities across the application.
 * Can be imported globally or per-module.
 *
 * Usage:
 * ```typescript
 * // Global import in app.module.ts
 * @Module({
 *   imports: [ThrottlerModule],
 * })
 * export class AppModule {}
 *
 * // Use in controllers
 * @Controller('api')
 * @UseGuards(ThrottlerGuard)
 * export class ApiController {
 *   @Throttle({ limit: 10, ttl: 60 })
 *   @Get('resource')
 *   getResource() {}
 * }
 * ```
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    SlidingWindowStrategy,
    {
      provide: RATE_LIMITER_STRATEGY,
      useExisting: SlidingWindowStrategy,
    },
    ThrottlerGuard,
    IpRateLimiterService,
  ],
  exports: [SlidingWindowStrategy, RATE_LIMITER_STRATEGY, ThrottlerGuard, IpRateLimiterService],
})
export class ThrottlerModule {}
