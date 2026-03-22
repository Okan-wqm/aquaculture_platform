import { Logger } from '@nestjs/common';
import { Resolver, Mutation, Args, Context } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, Public, SkipTenantGuard } from '@aquaculture/backend-common';

import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { AuthPayload } from '../dto/auth-response.dto';
import {
  SetupMfaResponse,
  VerifyMfaSetupInput,
  VerifyMfaSetupResponse,
  DisableMfaInput,
  DisableMfaResponse,
  VerifyMfaLoginInput,
  RegenerateMfaRecoveryCodesResponse,
} from '../dto/mfa.dto';
import { User } from '../entities/user.entity';
import { MfaService } from '../services/mfa.service';

interface GqlContext {
  req: Request;
  res: Response;
}

@Resolver(() => User)
export class MfaResolver {
  private readonly logger = new Logger(MfaResolver.name);
  private readonly isProduction: boolean;
  private readonly refreshTokenExpiryDays: number;

  constructor(
    private readonly mfaService: MfaService,
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
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: this.refreshTokenExpiryDays * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * Strip refresh token from response body
   */
  private stripRefreshToken(result: AuthPayload): AuthPayload {
    return { ...result, refreshToken: '' };
  }

  // ==========================================================================
  // MFA Setup (Authenticated)
  // ==========================================================================

  /**
   * Initiate MFA setup — generates TOTP secret, QR code URI, and recovery codes.
   * User must be authenticated. MFA is NOT enabled until verifyMfaSetup succeeds.
   */
  @SkipTenantGuard()
  @Mutation(() => SetupMfaResponse, { description: 'Initiate MFA setup for the current user' })
  async setupMfa(
    @CurrentUser('sub') userId: string,
  ): Promise<SetupMfaResponse> {
    return this.mfaService.setupMfa(userId);
  }

  /**
   * Verify the first TOTP code to complete MFA setup.
   * This enables MFA on the account.
   */
  @SkipTenantGuard()
  @Mutation(() => VerifyMfaSetupResponse, { description: 'Verify TOTP code to complete MFA setup' })
  async verifyMfaSetup(
    @CurrentUser('sub') userId: string,
    @Args('input') input: VerifyMfaSetupInput,
  ): Promise<VerifyMfaSetupResponse> {
    return this.mfaService.verifyMfaSetup(userId, input.code);
  }

  /**
   * Disable MFA — requires password and TOTP code for security.
   */
  @SkipTenantGuard()
  @Mutation(() => DisableMfaResponse, { description: 'Disable MFA (requires password + TOTP code)' })
  async disableMfa(
    @CurrentUser('sub') userId: string,
    @Args('input') input: DisableMfaInput,
  ): Promise<DisableMfaResponse> {
    return this.mfaService.disableMfa(userId, input.password, input.code);
  }

  /**
   * Regenerate recovery codes — requires TOTP code verification.
   * Invalidates all previous recovery codes.
   */
  @SkipTenantGuard()
  @Mutation(() => RegenerateMfaRecoveryCodesResponse, { description: 'Regenerate MFA recovery codes (invalidates previous)' })
  async regenerateMfaRecoveryCodes(
    @CurrentUser('sub') userId: string,
    @Args('code') code: string,
  ): Promise<RegenerateMfaRecoveryCodesResponse> {
    return this.mfaService.regenerateRecoveryCodes(userId, code);
  }

  // ==========================================================================
  // MFA Login Verification (Public — called during login flow)
  // ==========================================================================

  /**
   * Verify MFA code during login flow.
   *
   * Called after login returns mfaRequired=true with an mfaToken.
   * Accepts either a 6-digit TOTP code or a recovery code.
   * On success, returns full auth tokens.
   */
  @Public()
  @Mutation(() => AuthPayload, { description: 'Verify MFA during login (TOTP or recovery code)' })
  async verifyMfaLogin(
    @Args('input') input: VerifyMfaLoginInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    const forwarded = context.req?.headers?.['x-forwarded-for'];
    const ipAddress = context.req?.ip || (Array.isArray(forwarded) ? forwarded[0] : forwarded);
    const userAgent = context.req?.headers?.['user-agent'] as string | undefined;

    const result = await this.mfaService.verifyMfaLogin(
      input.mfaToken,
      input.code,
      ipAddress,
      userAgent,
    );

    // Set refresh token as httpOnly cookie
    this.setRefreshTokenCookie(context.res, result.refreshToken);
    return this.stripRefreshToken(result);
  }
}
