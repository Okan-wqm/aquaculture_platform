import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserConsent } from '@platform/backend-common';

import { User } from '../authentication/entities/user.entity';

import { UserConsentResolver } from './resolvers/user-consent.resolver';
import { UserConsentService } from './services/user-consent.service';

/**
 * GdprModule
 *
 * Provides GDPR/CCPA-compliant consent management for the auth-service.
 *
 * Features:
 * - User consent recording and tracking
 * - Consent withdrawal with reason logging
 * - Consent history and audit trail
 * - Tenant isolation
 *
 * This module uses the UserConsent entity from @platform/backend-common
 * which provides the base consent tracking functionality.
 *
 * Usage:
 * The module exposes GraphQL endpoints for:
 * - myConsentStatus: Get current user's consent status
 * - myConsentHistory: Get current user's consent history
 * - recordConsent: Record a single consent preference
 * - recordBulkConsent: Record multiple consent preferences
 * - withdrawConsent: Withdraw a previously granted consent
 *
 * Admin endpoints (SuperAdmin only):
 * - userConsentStatus: View any user's consent status
 * - userConsentHistory: View any user's consent history
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserConsent, User]),
  ],
  providers: [UserConsentService, UserConsentResolver],
  exports: [UserConsentService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class GdprModule {}
