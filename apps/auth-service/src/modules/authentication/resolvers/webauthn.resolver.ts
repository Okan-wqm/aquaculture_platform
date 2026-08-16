import { Logger } from '@nestjs/common';
import { Resolver, Mutation, Args, Query, Context } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';

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
import { WebAuthnService } from '../services/webauthn.service';
import {
  buildRefreshTokenCookieOptions,
  REFRESH_TOKEN_COOKIE_NAME,
} from '../utils/refresh-token-cookie';

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
   * Set refresh token as httpOnly cookie (same logic as AuthResolver)
   */
  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      token,
      buildRefreshTokenCookieOptions({
        isProduction: this.isProduction,
        rememberMe: true,
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
    @CurrentUser('sub') userId: string,
    @Args('input') input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    return this.webAuthnService.registerCredential(userId, input);
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
    @CurrentUser('sub') userId: string,
    @Args('credentialId') credentialId: string,
  ): Promise<WebAuthnRemoveResponse> {
    return this.webAuthnService.removeCredential(userId, credentialId);
  }

  // ==========================================================================
  // Authentication (Public)
  // ==========================================================================

  /**
   * Generate a challenge for WebAuthn login.
   * Public endpoint — called before authentication.
   */
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
   */
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
