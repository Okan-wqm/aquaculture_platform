import { UseGuards, Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Context,
} from '@nestjs/graphql';
import {
  CurrentUser,
  TenantAdminOrHigher,
  SuperAdminOnly,
  ConsentType,
} from '@platform/backend-common';

import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import {
  RecordConsentInput,
  RecordBulkConsentInput,
  WithdrawConsentInput,
  UserConsentStatus,
  UserConsentRecord,
  RecordConsentResult,
  BulkConsentResult,
  WithdrawConsentResult,
  ConsentHistoryResponse,
} from '../dto/user-consent.dto';
import {
  UserConsentService,
  ConsentRequestContext,
} from '../services/user-consent.service';

/**
 * Request interface for extracting context
 */
interface GraphQLRequest {
  ip?: string;
  headers?: {
    'user-agent'?: string;
    'x-forwarded-for'?: string;
  };
  connection?: {
    remoteAddress?: string;
  };
}

/**
 * UserConsentResolver
 *
 * GraphQL resolver for user consent operations.
 * Implements GDPR-compliant consent management.
 *
 * Security:
 * - All endpoints require authentication
 * - Users can only manage their own consents (except SuperAdmin read access)
 * - Tenant isolation enforced through @CurrentUser decorator
 * - IP address and user agent captured for audit trail
 *
 * Operations:
 * - recordConsent: Grant or deny a specific consent
 * - recordBulkConsent: Grant or deny multiple consents at once
 * - withdrawConsent: Withdraw a previously granted consent
 * - myConsentStatus: Get current consent status
 * - myConsentHistory: Get full consent history
 * - hasConsent: Check if user has specific consent
 *
 * Admin Operations (SuperAdmin only):
 * - userConsentStatus: View any user's consent status
 * - userConsentHistory: View any user's consent history
 */
@Resolver()
@UseGuards(JwtAuthGuard)
export class UserConsentResolver {
  private readonly logger = new Logger(UserConsentResolver.name);

  constructor(private readonly userConsentService: UserConsentService) {}

  // =========================================================================
  // User Self-Service Queries
  // =========================================================================

  /**
   * Get current consent status for the authenticated user
   */
  @Query(() => UserConsentStatus, {
    description: 'Get current consent status for the authenticated user',
  })
  @TenantAdminOrHigher()
  async myConsentStatus(
    @CurrentUser('sub') userId: string,
  ): Promise<UserConsentStatus> {
    this.logger.debug(`Getting consent status for user ${userId}`);
    return this.userConsentService.getConsentStatus(userId);
  }

  /**
   * Get consent history for the authenticated user
   */
  @Query(() => ConsentHistoryResponse, {
    description: 'Get consent history for the authenticated user',
  })
  @TenantAdminOrHigher()
  async myConsentHistory(
    @CurrentUser('sub') userId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 })
    limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset?: number,
  ): Promise<ConsentHistoryResponse> {
    this.logger.debug(`Getting consent history for user ${userId}`);
    return this.userConsentService.getConsentHistory(
      userId,
      limit ?? 50,
      offset ?? 0,
    );
  }

  /**
   * Check if user has given specific consent
   */
  @Query(() => Boolean, {
    description: 'Check if user has given specific consent',
  })
  @TenantAdminOrHigher()
  async hasConsent(
    @CurrentUser('sub') userId: string,
    @Args('consentType', { type: () => ConsentType }) consentType: ConsentType,
  ): Promise<boolean> {
    return this.userConsentService.hasConsent(userId, consentType);
  }

  /**
   * Get current consent version
   */
  @Query(() => String, {
    description: 'Get current consent version',
  })
  @TenantAdminOrHigher()
  async currentConsentVersion(): Promise<string> {
    return this.userConsentService.getCurrentVersion();
  }

  /**
   * Check if user's consent is outdated
   */
  @Query(() => Boolean, {
    description: 'Check if user needs to update their consent preferences',
  })
  @TenantAdminOrHigher()
  async isConsentOutdated(
    @CurrentUser('sub') userId: string,
  ): Promise<boolean> {
    return this.userConsentService.isConsentOutdated(userId);
  }

  // =========================================================================
  // User Self-Service Mutations
  // =========================================================================

  /**
   * Record a single consent preference
   */
  @Mutation(() => RecordConsentResult, {
    description: 'Record a single consent preference',
  })
  @TenantAdminOrHigher()
  async recordConsent(
    @CurrentUser('sub') userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
    @Args('input') input: RecordConsentInput,
    @Context() ctx: { req: GraphQLRequest },
  ): Promise<RecordConsentResult> {
    const context = this.extractRequestContext(userId, tenantId, ctx.req);

    this.logger.log(
      `Recording consent for user ${userId}: ${input.consentType} = ${input.granted}`,
    );

    return this.userConsentService.recordConsent(context, input);
  }

  /**
   * Record multiple consent preferences at once
   */
  @Mutation(() => BulkConsentResult, {
    description: 'Record multiple consent preferences at once',
  })
  @TenantAdminOrHigher()
  async recordBulkConsent(
    @CurrentUser('sub') userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
    @Args('input') input: RecordBulkConsentInput,
    @Context() ctx: { req: GraphQLRequest },
  ): Promise<BulkConsentResult> {
    const context = this.extractRequestContext(userId, tenantId, ctx.req);

    this.logger.log(
      `Recording bulk consent for user ${userId}: ${input.consents.length} consents`,
    );

    return this.userConsentService.recordBulkConsent(context, input.consents);
  }

  /**
   * Withdraw a previously granted consent
   */
  @Mutation(() => WithdrawConsentResult, {
    description: 'Withdraw a previously granted consent',
  })
  @TenantAdminOrHigher()
  async withdrawConsent(
    @CurrentUser('sub') userId: string,
    @CurrentUser('tenantId') tenantId: string | null,
    @Args('input') input: WithdrawConsentInput,
    @Context() ctx: { req: GraphQLRequest },
  ): Promise<WithdrawConsentResult> {
    const context = this.extractRequestContext(userId, tenantId, ctx.req);

    this.logger.log(
      `Withdrawing consent for user ${userId}: ${input.consentType}`,
    );

    return this.userConsentService.withdrawConsent(context, input);
  }

  // =========================================================================
  // Admin Queries (SuperAdmin only - Read-only access for auditing)
  // =========================================================================

  /**
   * Get consent status for any user (SuperAdmin only)
   * Used for compliance auditing
   */
  @Query(() => UserConsentStatus, {
    description: 'Get consent status for any user (SuperAdmin only)',
  })
  @SuperAdminOnly()
  async userConsentStatus(
    @CurrentUser('sub') requestingUserId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<UserConsentStatus> {
    this.logger.log(
      `SuperAdmin ${requestingUserId} viewing consent status for user ${targetUserId}`,
    );

    return this.userConsentService.getConsentStatusForUser(
      requestingUserId,
      targetUserId,
    );
  }

  /**
   * Get consent history for any user (SuperAdmin only)
   * Used for compliance auditing
   */
  @Query(() => ConsentHistoryResponse, {
    description: 'Get consent history for any user (SuperAdmin only)',
  })
  @SuperAdminOnly()
  async userConsentHistory(
    @CurrentUser('sub') requestingUserId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 })
    limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset?: number,
  ): Promise<ConsentHistoryResponse> {
    this.logger.log(
      `SuperAdmin ${requestingUserId} viewing consent history for user ${targetUserId}`,
    );

    return this.userConsentService.getConsentHistoryForUser(
      requestingUserId,
      targetUserId,
      limit ?? 50,
      offset ?? 0,
    );
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  /**
   * Extract request context for consent operations
   * Captures IP address and user agent for audit trail
   */
  private extractRequestContext(
    userId: string,
    tenantId: string | null,
    req: GraphQLRequest,
  ): ConsentRequestContext {
    // Extract IP address (handle proxies)
    let ipAddress: string | undefined;
    if (req.headers?.['x-forwarded-for']) {
      // Take first IP from X-Forwarded-For header
      const forwardedFor = req.headers['x-forwarded-for'];
      ipAddress = forwardedFor.split(',')[0]?.trim();
    } else if (req.ip) {
      ipAddress = req.ip;
    } else if (req.connection?.remoteAddress) {
      ipAddress = req.connection.remoteAddress;
    }

    // Extract user agent
    const userAgent = req.headers?.['user-agent'];

    return {
      userId,
      tenantId,
      ipAddress,
      userAgent,
    };
  }
}
