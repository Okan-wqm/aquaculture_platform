import { Logger } from '@nestjs/common';
import { Resolver, Mutation, Args, Query, Context } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { RateLimit } from '@aquaculture/backend-common/rate-limit';

import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { AuthPayload } from '../dto/auth-response.dto';
import {
  WebAuthnRegistrationChallengeInput,
  WebAuthnRegistrationChallengeResponse,
  WebAuthnRegisterCredentialInput,
  WebAuthnRegisterResponse,
  WebAuthnLoginChallengeInput,
  WebAuthnLoginChallengeResponse,
  WebAuthnVerifyLoginInput,
  WebAuthnCredentialInfo,
  WebAuthnRemoveResponse,
} from '../dto/webauthn.dto';
import { User } from '../entities/user.entity';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  buildRefreshTokenCookieOptions,
} from '../utils/refresh-token-cookie';
import { WebAuthnService } from '../services/webauthn.service';
import type { OriginatingAccessSession } from '../services/token.service';

interface GqlContext {
  req: Request;
  res: Response;
}

@Resolver(() => User)
export class WebAuthnResolver {
  private readonly logger = new Logger(WebAuthnResolver.name);
  private readonly isProduction: boolean;
  private readonly refreshTokenExpiryDays: number;

  constructor(
    private readonly webAuthnService: WebAuthnService,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    this.refreshTokenExpiryDays = this.configService.get<number>(
      'REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS,
    );
  }

  /**
   * Set the refresh token cookie through the platform SSoT helper.
   *
   * SEC-LOW (2026-08-23 scan №69b): this resolver previously rolled its own
   * cookie options — always-persistent maxAge and Express's default
   * percent-encoding, both diverging from the refresh-token-cookie SSoT
   * (identity encoder + rememberMe-scoped persistence). Biometric login is
   * a session-cookie flow: rememberMe false.
   */
  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      token,
      buildRefreshTokenCookieOptions({
        isProduction: this.isProduction,
        rememberMe: false,
        rememberMeExpiryDays: this.refreshTokenExpiryDays,
      }),
    );
  }

  /**
   * Strip refresh token from response body
   */
  private stripRefreshToken(result: AuthPayload): AuthPayload {
    return { ...result, refreshToken: '' };
  }

  // ==========================================================================
  // Registration (Authenticated)
  // ==========================================================================

  /**
   * Generate a challenge for WebAuthn credential registration.
   * User must be authenticated (logged in with email+password first).
   */
  @SkipTenantGuard()
  @Mutation(() => WebAuthnRegistrationChallengeResponse, {
    description: 'Generate challenge for biometric credential registration',
  })
  async webAuthnRegistrationChallenge(
    @CurrentUser('sub') userId: string,
    @Args('input', { nullable: true }) input?: WebAuthnRegistrationChallengeInput,
  ): Promise<WebAuthnRegistrationChallengeResponse> {
    return this.webAuthnService.generateRegistrationChallenge(userId, input?.deviceName);
  }

  /**
   * Register a new WebAuthn credential after the browser ceremony completes.
   * User must be authenticated.
   */
  @SkipTenantGuard()
  @Mutation(() => WebAuthnRegisterResponse, {
    description: 'Register a new biometric credential',
  })
  async registerWebAuthnCredential(
    @CurrentUser() session: OriginatingAccessSession,
    @Args('input') input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    return this.webAuthnService.registerCredential(session, input);
  }

  /**
   * List all WebAuthn credentials for the current user.
   */
  @SkipTenantGuard()
  @Query(() => [WebAuthnCredentialInfo], {
    description: 'List biometric credentials for the current user',
  })
  async myWebAuthnCredentials(
    @CurrentUser('sub') userId: string,
  ): Promise<WebAuthnCredentialInfo[]> {
    return this.webAuthnService.getUserCredentials(userId);
  }

  /**
   * Check if the current user has any WebAuthn credentials.
   */
  @SkipTenantGuard()
  @Query(() => Boolean, {
    description: 'Check if the current user has biometric login enabled',
  })
  async hasWebAuthnCredentials(@CurrentUser('sub') userId: string): Promise<boolean> {
    return this.webAuthnService.hasCredentials(userId);
  }

  /**
   * Remove a WebAuthn credential.
   */
  @SkipTenantGuard()
  @Mutation(() => WebAuthnRemoveResponse, {
    description: 'Remove a biometric credential',
  })
  async removeWebAuthnCredential(
    @CurrentUser() session: OriginatingAccessSession,
    @Args('credentialId') credentialId: string,
  ): Promise<WebAuthnRemoveResponse> {
    return this.webAuthnService.removeCredential(session, credentialId);
  }

  // ==========================================================================
  // Authentication (Public)
  // ==========================================================================

  /**
   * Generate a challenge for WebAuthn login.
   * Public endpoint — called before authentication.
   *
   * SEC-LOW (2026-08-23 scan №7/№40): same per-email budget shape as the
   * password login mutation — unthrottled challenge issuance was both a
   * Redis-fill lane and an enrollment oracle.
   */
  @RateLimit({
    name: 'webauthn-login-challenge',
    limit: 5,
    windowMs: 15 * 60_000,
    identifier: ({ args }) =>
      ((args?.['input'] as { email?: string } | undefined)?.email ?? '').toLowerCase() || undefined,
  })
  @Public()
  @Mutation(() => WebAuthnLoginChallengeResponse, {
    description: 'Generate challenge for biometric login',
  })
  async webAuthnLoginChallenge(
    @Args('input') input: WebAuthnLoginChallengeInput,
  ): Promise<WebAuthnLoginChallengeResponse> {
    return this.webAuthnService.generateLoginChallenge(input.email);
  }

  /**
   * Verify WebAuthn assertion and complete biometric login.
   * Public endpoint — issues JWT tokens on success.
   *
   * Challenges are single-use (Redis GETDEL), so assertion brute-force is
   * bounded by challenge issuance (5/15min per email above); this budget
   * bounds the verify lane itself.
   */
  @RateLimit({ name: 'webauthn-verify', limit: 10, windowMs: 15 * 60_000 })
  @Public()
  @Mutation(() => AuthPayload, {
    description: 'Verify biometric assertion and login',
  })
  async verifyWebAuthnLogin(
    @Args('input') input: WebAuthnVerifyLoginInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    const forwarded = context.req?.headers?.['x-forwarded-for'];
    const ipAddress = context.req?.ip || (Array.isArray(forwarded) ? forwarded[0] : forwarded);
    const userAgent = context.req?.headers?.['user-agent'] as string | undefined;

    const result = await this.webAuthnService.verifyLogin(input, ipAddress, userAgent);

    // Set refresh token as httpOnly cookie
    this.setRefreshTokenCookie(context.res, result.refreshToken);
    return this.stripRefreshToken(result);
  }
}
