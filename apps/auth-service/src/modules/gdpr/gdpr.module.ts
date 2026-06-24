import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserConsent } from '@aquaculture/backend-common/gdpr';

import { User } from '../authentication/entities/user.entity';
import { RefreshToken } from '../authentication/entities/refresh-token.entity';
// AuthenticationModule imported to provide AuthenticationService for GdprComplianceService.
// GdprComplianceService (erasure + data export) lives in privacy/ but is registered here
// because it's semantically GDPR and depends on AuthenticationService.
import { AuthenticationModule } from '../authentication/authentication.module';
import { GdprComplianceService } from '../../privacy/gdpr-compliance.service';

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
 * This module uses the UserConsent entity from @aquaculture/backend-common
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
    TypeOrmModule.forFeature([UserConsent, User, RefreshToken]),
    // AuthenticationModule exports AuthenticationService (for logoutAllDevices)
    // and TypeOrmModule (User + RefreshToken repos available via forFeature above).
    AuthenticationModule,
  ],
  providers: [UserConsentService, UserConsentResolver, GdprComplianceService],
  exports: [UserConsentService, GdprComplianceService],
})
 
export class GdprModule {}
