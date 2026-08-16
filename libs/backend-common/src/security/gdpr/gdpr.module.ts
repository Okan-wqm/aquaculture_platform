import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CONSENT_MANAGER, GDPR_SERVICE } from '../interfaces';

import { ConsentManagerService } from './consent-manager.service';
import { UserConsent } from './entities/consent.entity';
import { GdprDataRequest } from './entities/data-request.entity';
import { GdprService } from './gdpr.service';

/**
 * GDPR Module
 *
 * Provides GDPR/CCPA compliance capabilities:
 * - Consent management
 * - Data export (Right to Access)
 * - Data deletion (Right to Erasure)
 * - Data rectification
 * - Processing restriction
 *
 * Usage:
 * ```typescript
 * // Import in app.module.ts
 * @Module({
 *   imports: [GdprModule],
 * })
 * export class AppModule {}
 *
 * // Use in services
 * @Injectable()
 * export class UserService {
 *   constructor(
 *     @Inject(GDPR_SERVICE) private readonly gdprService: IGdprService,
 *     @Inject(CONSENT_MANAGER) private readonly consentManager: IConsentManager,
 *   ) {}
 *
 *   async exportMyData(userId: string) {
 *     return this.gdprService.exportUserData(userId);
 *   }
 *
 *   async checkConsent(userId: string) {
 *     return this.consentManager.hasConsent(userId, ConsentType.ANALYTICS);
 *   }
 * }
 * ```
 */
@Global()
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([UserConsent, GdprDataRequest])],
  providers: [
    GdprService,
    ConsentManagerService,
    {
      provide: GDPR_SERVICE,
      useExisting: GdprService,
    },
    {
      provide: CONSENT_MANAGER,
      useExisting: ConsentManagerService,
    },
  ],
  exports: [GdprService, ConsentManagerService, GDPR_SERVICE, CONSENT_MANAGER, TypeOrmModule],
})
export class GdprModule {}
