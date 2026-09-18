import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { IP_VALIDATOR } from './interfaces';
import { IpValidatorService } from './ip-validation';
import { SessionManagerModule } from './session-manager';
import { ThrottlerModule } from './throttler';
import { TimingSafeService } from './timing-safe';
import { InputSanitizerService } from './validators/input-sanitizer.service';

/**
 * Security Module
 *
 * Comprehensive security module providing:
 * - Rate limiting (Throttler)
 * Per-JTI token blacklisting is deliberately not aggregated here: auth-service
 * is the sole writer and imports TokenBlacklistModule explicitly.
 * - Session management (Concurrent session limits)
 * - Timing attack protection
 * - IP validation and extraction
 * - Input sanitization
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
  imports: [ConfigModule, ThrottlerModule, SessionManagerModule],
  providers: [
    TimingSafeService,
    IpValidatorService,
    InputSanitizerService,
    {
      provide: IP_VALIDATOR,
      useExisting: IpValidatorService,
    },
  ],
  exports: [
    // Modules
    ThrottlerModule,
    SessionManagerModule,
    // Services
    TimingSafeService,
    IpValidatorService,
    InputSanitizerService,
    IP_VALIDATOR,
  ],
})
export class SecurityModule {}
