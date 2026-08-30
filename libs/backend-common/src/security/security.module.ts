import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ThrottlerModule } from './throttler';
import { TokenBlacklistModule } from './token-blacklist';
import { SessionManagerModule } from './session-manager';
import { TimingSafeService } from './timing-safe';
import { IpValidatorService } from './ip-validation';
import { InputSanitizerService } from './validators/input-sanitizer.service';
import { IdorGuard } from './validators/idor-guard';
import { IP_VALIDATOR } from './interfaces';

/**
 * Security Module
 *
 * Comprehensive security module providing:
 * - Rate limiting (Throttler)
 * - Token blacklisting (Access token invalidation)
 * - Session management (Concurrent session limits)
 * - Timing attack protection
 * - IP validation and extraction
 * - Input sanitization
 * - IDOR protection
 *
 * Usage:
 * ```typescript
 * // Import in app.module.ts
 * @Module({
 *   imports: [SecurityModule],
 * })
 * export class AppModule {}
 * ```
 *
 * For GDPR compliance, import GdprModule separately as it requires
 * TypeORM entities to be registered.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    ThrottlerModule,
    TokenBlacklistModule,
    SessionManagerModule,
  ],
  providers: [
    TimingSafeService,
    IpValidatorService,
    InputSanitizerService,
    IdorGuard,
    {
      provide: IP_VALIDATOR,
      useExisting: IpValidatorService,
    },
  ],
  exports: [
    // Modules
    ThrottlerModule,
    TokenBlacklistModule,
    SessionManagerModule,
    // Services
    TimingSafeService,
    IpValidatorService,
    InputSanitizerService,
    IdorGuard,
    IP_VALIDATOR,
  ],
})
export class SecurityModule {}
