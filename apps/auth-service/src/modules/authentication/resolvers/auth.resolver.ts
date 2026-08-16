import { CurrentUser, Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { resolveClientNetworkContext } from '@aquaculture/backend-common/http';
import { RateLimit } from '@aquaculture/backend-common/rate-limit';
import { UnauthorizedException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver, Mutation, Args, Query, Context } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { AuthDomainMetricsService } from '../../../metrics/auth-domain-metrics.service';
import { AcceptInvitationInput } from '../dto/accept-invitation.dto';
import {
  AuthPayload,
  LogoutResponse,
  TokenValidationResponse,
  MePayload,
  InvitationValidationResponse,
} from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { RefreshTokenInput } from '../dto/refresh-token.dto';
import { ForgotPasswordInput, ResetPasswordInput } from '../dto/reset-password.dto';
import { User } from '../entities/user.entity';
import { AuthenticationService } from '../services/authentication.service';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  buildRefreshTokenCookieOptions,
  buildClearRefreshTokenCookieOptions,
} from '../utils/refresh-token-cookie';

/**
 * GraphQL context with req/res for cookie operations
 */
interface GqlContext {
  req: Request;
  res: Response;
}

@Resolver(() => User)
export class AuthResolver {
  private readonly logger = new Logger(AuthResolver.name);
  private readonly isProduction: boolean;
  private readonly rememberMeRefreshTokenExpiryDays: number;

  constructor(
    private readonly authService: AuthenticationService,
    private readonly configService: ConfigService,
    // @Optional so unit tests can construct the resolver without the metrics
    // module; in production AuthMetricsModule is @Global and always provides it.
    @Optional() private readonly authMetrics?: AuthDomainMetricsService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    this.rememberMeRefreshTokenExpiryDays = this.configService.get<number>(
      'REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS,
    );
  }

  /**
   * SECURITY: Set refresh token as httpOnly cookie. Persistence is the ONLY
   * variable (rememberMe → persistent maxAge; else session cookie); every other
   * attribute is fixed by the shared cookie SSoT. See refresh-token-cookie.ts.
   */
  private setRefreshTokenCookie(res: Response, token: string, rememberMe: boolean): void {
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      token,
      buildRefreshTokenCookieOptions({
        isProduction: this.isProduction,
        rememberMe,
        rememberMeExpiryDays: this.rememberMeRefreshTokenExpiryDays,
      }),
    );
  }

  private clearRefreshTokenCookie(res: Response): void {
    res.clearCookie(
      REFRESH_TOKEN_COOKIE_NAME,
      buildClearRefreshTokenCookieOptions(this.isProduction),
    );
  }

  /**
   * Strip refresh token from response body (it's in the httpOnly cookie instead)
   */
  private stripRefreshToken(result: AuthPayload): AuthPayload {
    return { ...result, refreshToken: '' };
  }

  // SECURITY (SEC-CRITICAL-001): the public `register` mutation was REMOVED.
  // It accepted a client-supplied tenantId with no tenant validation —
  // anonymous cross-tenant account injection at the identity primitive.
  // User creation flows through exactly two server-governed paths:
  //   1. invitation flow (acceptInvitation — token resolves the tenant)
  //   2. provisioning saga first-admin creation (admin-api → NATS command)
  // Re-introducing public self-registration requires a dedicated
  // "new tenant + first admin" onboarding saga, never a write into an
  // existing tenant. See docs/reviews/auth-security-expert/
  // 2026-06-10-auth-service-audit.md#SEC-CRITICAL-001.

  // SECURITY (SEC-CRITICAL-002 / ADR-008): service-local limiting so a
  // gateway bypass or direct internal-network subgraph reach still faces a
  // brute-force window. The email identifier shares one budget per account
  // across IPs — distributed credential stuffing cannot rotate around it.
  @RateLimit({
    name: 'login',
    limit: 5,
    windowMs: 15 * 60_000,
    identifier: ({ args }) =>
      ((args?.['input'] as { email?: string } | undefined)?.email ?? '').toLowerCase() || undefined,
  })
  @Public()
  @Mutation(() => AuthPayload)
  async login(
    @Args('input') input: LoginInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    // PERF-MEDIUM-003: tier-0 login latency SLI. Record on BOTH paths — a failed
    // login (wrong credentials / brute-force probe) is part of the latency SLO,
    // not excluded from it.
    const stop = this.authMetrics?.startOperation('login');
    try {
      const request = context.req;
      // ORPHAN-MEDIUM-319: behind the gateway, request.ip is ALWAYS the
      // gateway container; the true actor arrives via the gateway-minted
      // (service-identity-gated) client network headers. The old
      // `request.ip || x-forwarded-for` ordering pinned every audit row and
      // lastLoginIp to ::ffff:172.18.0.x.
      const { ip: ipAddress, userAgent } = resolveClientNetworkContext(request);
      const result = await this.authService.login(input, ipAddress, userAgent);
      this.setRefreshTokenCookie(context.res, result.refreshToken, result.rememberMe ?? false);
      const payload = this.stripRefreshToken(result);
      stop?.('success');
      return payload;
    } catch (err) {
      stop?.('error');
      throw err;
    }
  }

  @RateLimit({ name: 'refresh', limit: 10, windowMs: 5 * 60_000 })
  @Public()
  @Mutation(() => AuthPayload)
  async refreshToken(
    @Args('input') input: RefreshTokenInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    // SECURITY: Prefer httpOnly cookie, fall back to body for backward
    // compatibility. express cookies are untyped at the boundary —
    // narrow before the token flows into the auth service.
    const cookieToken: unknown = context.req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    const token =
      typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : input.refreshToken;
    if (!token) {
      throw new UnauthorizedException('No refresh token provided');
    }
    const result = await this.authService.refreshToken(token);
    // Rotate the refresh token cookie, preserving the session's rememberMe choice.
    this.setRefreshTokenCookie(context.res, result.refreshToken, result.rememberMe ?? false);
    return this.stripRefreshToken(result);
  }

  /**
   * Accept invitation and set password
   * Password validation: min 8 chars, uppercase, lowercase, number, special char
   */
  @Public()
  @Mutation(() => AuthPayload)
  async acceptInvitation(
    @Args('input') input: AcceptInvitationInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    // ORPHAN-MEDIUM-319: gateway-resolved client identity (see login()).
    const { ip: ipAddress } = resolveClientNetworkContext(context.req);
    const result = await this.authService.acceptInvitation(
      input.token,
      input.password,
      input.firstName,
      input.lastName,
      ipAddress,
    );
    // Invitation acceptance / password reset is not a "remember me" event → session cookie.
    this.setRefreshTokenCookie(context.res, result.refreshToken, false);
    return this.stripRefreshToken(result);
  }

  /**
   * Forgot password - initiates password reset flow.
   *
   * SECURITY:
   * - Always returns true regardless of whether the email exists (user enumeration prevention)
   * - Rate limited at gateway level (3/hour for password reset - D08)
   * - Timing-safe: takes the same amount of time whether user exists or not
   * - If the email exists, publishes PasswordResetRequestedEvent for notification service
   */
  // WHY per-email budget: reset-token flooding spams the victim's inbox and
  // churns tokens; 3/hour per account regardless of source IP.
  @RateLimit({
    name: 'password-reset-request',
    limit: 3,
    windowMs: 60 * 60_000,
    identifier: ({ args }) =>
      ((args?.['input'] as { email?: string } | undefined)?.email ?? '').toLowerCase() || undefined,
  })
  @Public()
  @Mutation(() => Boolean)
  async forgotPassword(
    @Args('input') input: ForgotPasswordInput,
    @Context() context: GqlContext,
  ): Promise<boolean> {
    // ORPHAN-MEDIUM-319: gateway-resolved client identity (see login()).
    const { ip: ipAddress } = resolveClientNetworkContext(context.req);
    // SECURITY: Always return true to prevent user enumeration
    await this.authService.initiatePasswordReset(input.email, ipAddress);
    return true;
  }

  /**
   * Reset password using a valid reset token.
   *
   * SECURITY:
   * - @Public() - unauthenticated access required (user forgot their password)
   * - Token is validated and single-use (cleared after successful reset)
   * - All existing sessions and refresh tokens are revoked
   * - Returns new auth tokens so user is immediately logged in
   * - Password validation: min 8, uppercase, lowercase, digit, special char (via DTO)
   * - Refresh token is set as httpOnly cookie
   */
  @RateLimit({ name: 'password-reset', limit: 3, windowMs: 60 * 60_000 })
  @Public()
  @Mutation(() => AuthPayload)
  async resetPassword(
    @Args('input') input: ResetPasswordInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    // ORPHAN-MEDIUM-319: gateway-resolved client identity (see login()).
    const { ip: ipAddress, userAgent } = resolveClientNetworkContext(context.req);
    const result = await this.authService.resetPassword(
      input.token,
      input.newPassword,
      ipAddress,
      userAgent,
    );
    // Invitation acceptance / password reset is not a "remember me" event → session cookie.
    this.setRefreshTokenCookie(context.res, result.refreshToken, false);
    return this.stripRefreshToken(result);
  }

  /**
   * Validate invitation token (to show accept form)
   */
  @Public()
  @Query(() => InvitationValidationResponse)
  async validateInvitation(@Args('token') token: string): Promise<InvitationValidationResponse> {
    return this.authService.validateInvitation(token);
  }

  @SkipTenantGuard()
  @Mutation(() => LogoutResponse)
  async logout(
    @CurrentUser('sub') userId: string,
    @CurrentUser('jti') jti: string | undefined,
    @CurrentUser('exp') exp: number | undefined,
    @Context() context: GqlContext,
  ): Promise<LogoutResponse> {
    // SECURITY: Pass jti and exp so the access token can be blacklisted until it expires
    const accessTokenExpiry = exp ? new Date(exp * 1000) : undefined;
    const success = await this.authService.logout(userId, jti, accessTokenExpiry);
    // SECURITY: Clear refresh token cookie on logout
    this.clearRefreshTokenCookie(context.res);
    return { success, message: success ? 'Logged out successfully' : 'Logout failed' };
  }

  /**
   * Get current user profile with accessible modules and redirect path
   */
  @SkipTenantGuard()
  @Query(() => MePayload)
  async me(
    @CurrentUser('sub') userId: string,
    // The JWT tenant claim is the authoritative effective tenant for the session;
    // `me` reports it so the frontend scopes its queries to that tenant. For a
    // normal user it equals the DB tenant; a platform SUPER_ADMIN has none (null).
    @CurrentUser('tenantId') effectiveTenantId: string | null,
  ): Promise<MePayload> {
    return this.authService.me(userId, effectiveTenantId);
  }

  /**
   * Get current user entity only (simplified version)
   */
  @SkipTenantGuard()
  @Query(() => User)
  async currentUser(@CurrentUser('sub') userId: string): Promise<User> {
    const user = await this.authService.getUserById(userId);
    if (!user) {
      // SECURITY: Generic message to prevent information leakage
      throw new UnauthorizedException('Authentication failed');
    }
    return user;
  }

  @SkipTenantGuard()
  @Query(() => TokenValidationResponse)
  async validateToken(@Args('token') token: string): Promise<TokenValidationResponse> {
    // PERF-MEDIUM-003: tier-0 token-validation latency SLI. An invalid token is a
    // successful OPERATION (it ran to completion); only a thrown error is 'error'.
    const stop = this.authMetrics?.startOperation('token_validation');
    try {
      const result = await this.authService.validateToken(token);
      if (!result.valid || !result.payload) {
        stop?.('success');
        return { valid: false };
      }

      // Calculate expiration from JWT exp claim or default to 15 minutes from now
      const expiresAt = result.payload.exp
        ? new Date(result.payload.exp * 1000)
        : new Date(Date.now() + 15 * 60 * 1000);

      stop?.('success');
      return {
        valid: true,
        userId: result.payload.sub,
        tenantId: result.payload.tenantId ?? undefined,
        role: result.payload.role,
        expiresAt,
      };
    } catch (err) {
      stop?.('error');
      throw err;
    }
  }
}
