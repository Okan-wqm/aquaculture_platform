import { CurrentUser, Public, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { RateLimit } from '@aquaculture/backend-common/rate-limit';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver, Mutation, Args, Context } from '@nestjs/graphql';
import { Request, Response } from 'express';

import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { AuthPayload } from '../dto/auth-response.dto';
import {
  SetupMfaResponse,
  VerifyMfaSetupInput,
  VerifyMfaSetupResponse,
  DisableMfaInput,
  DisableMfaResponse,
  VerifyMfaLoginInput,
  MfaStepUpInput,
  RegenerateMfaRecoveryCodesResponse,
} from '../dto/mfa.dto';
import { User } from '../entities/user.entity';
import { MfaService } from '../services/mfa.service';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  buildRefreshTokenCookieOptions,
} from '../utils/refresh-token-cookie';

/**
 * The exact request/response surface this resolver touches (a structural
 * narrowing of express Request/Response). `user` is attached by JwtAuthGuard —
 * on authenticated routes, and best-effort on @Public routes (ADR-046) — or by
 * the gateway-forwarded x-user-payload middleware.
 */
interface GqlContext {
  req: Pick<Request, 'headers' | 'ip'> & { user?: { sub: string } };
  res: Pick<Response, 'cookie'>;
}

@Resolver(() => User)
export class MfaResolver {
  private readonly logger = new Logger(MfaResolver.name);
  private readonly isProduction: boolean;
  private readonly rememberMeRefreshTokenExpiryDays: number;

  constructor(
    private readonly mfaService: MfaService,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    this.rememberMeRefreshTokenExpiryDays = this.configService.get<number>(
      'REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS,
    );
  }

  /**
   * Set refresh token as httpOnly cookie via the shared cookie SSoT
   * (same persistence contract as AuthResolver). See refresh-token-cookie.ts.
   */
  private setRefreshTokenCookie(
    res: Pick<Response, 'cookie'>,
    token: string,
    rememberMe: boolean,
  ): void {
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

  /**
   * Strip refresh token from response body
   */
  private stripRefreshToken(result: AuthPayload): AuthPayload {
    return { ...result, refreshToken: '' };
  }

  // ==========================================================================
  // MFA Setup (authenticated session OR the ADR-046 mfa_setup token)
  // ==========================================================================

  /**
   * ADR-046: resolve the subject of an MFA enrollment operation from EITHER an
   * authenticated session OR a valid mfa_setup token — never both, never
   * neither.
   *
   * Precedence: an authenticated identity WINS and the token argument is
   * ignored, so a setup token can never redirect an authenticated user's
   * enrollment to another account. Without a session, the mfa_setup token —
   * minted by login after password validation when the tenant enforces MFA —
   * is the credential (MfaService positively requires type === 'mfa_setup').
   * These two mutations are the ONLY consumers of the setup token.
   */
  private resolveMfaSubject(context: GqlContext, mfaSetupToken?: string | null): string {
    const authenticatedUserId = context.req?.user?.sub;
    if (authenticatedUserId) {
      return authenticatedUserId;
    }
    if (!mfaSetupToken) {
      throw new UnauthorizedException('Authentication or an MFA setup token is required');
    }
    return this.mfaService.resolveSetupTokenUserId(mfaSetupToken);
  }

  /**
   * Initiate MFA setup — generates TOTP secret, QR code URI, and recovery codes.
   * MFA is NOT enabled until verifyMfaSetup succeeds.
   *
   * ADR-046: @Public so the pre-session enrollment path (tenant enforces MFA,
   * user has no factor — login returned mfaSetupRequired + mfaSetupToken) can
   * reach it. An authenticated session keeps working unchanged: JwtAuthGuard
   * attaches optional identity on public routes and resolveMfaSubject gives
   * the session precedence over any token argument.
   */
  // SECURITY: a pre-session surface → velocity-limited per setup token (the
  // SEC-CRITICAL-002 pattern verifyMfaLogin established). Authenticated calls
  // carry no token argument, so the identifier dimension falls back to user/ip.
  @RateLimit({
    name: 'mfa-setup-init',
    limit: 5,
    windowMs: 15 * 60_000,
    identifier: ({ args }) => (args?.['mfaSetupToken'] as string | undefined) || undefined,
  })
  @Public()
  @SkipTenantGuard()
  @Mutation(() => SetupMfaResponse, { description: 'Initiate MFA setup for the current user' })
  async setupMfa(
    @Context() context: GqlContext,
    @Args('mfaSetupToken', {
      type: () => String,
      nullable: true,
      description:
        'MFA setup token from login (mfaSetupRequired=true) — identifies the user when no authenticated session exists',
    })
    mfaSetupToken?: string,
  ): Promise<SetupMfaResponse> {
    return this.mfaService.setupMfa(this.resolveMfaSubject(context, mfaSetupToken));
  }

  /**
   * Verify the first TOTP code to complete MFA setup.
   * This enables MFA on the account.
   *
   * ADR-046: also reachable with input.mfaSetupToken (pre-session enrollment).
   * On success via a setup token NO tokens are issued — the response is only
   * `{ success: true }`. The user then signs in again: with MFA now enrolled,
   * login takes the normal mfa_challenge flow. That deliberate extra login
   * keeps token issuance on exactly one audited path.
   */
  @RateLimit({
    name: 'mfa-setup-verify',
    limit: 5,
    windowMs: 15 * 60_000,
    identifier: ({ args }) =>
      (args?.['input'] as { mfaSetupToken?: string } | undefined)?.mfaSetupToken || undefined,
  })
  @Public()
  @SkipTenantGuard()
  @Mutation(() => VerifyMfaSetupResponse, { description: 'Verify TOTP code to complete MFA setup' })
  async verifyMfaSetup(
    @Context() context: GqlContext,
    @Args('input') input: VerifyMfaSetupInput,
  ): Promise<VerifyMfaSetupResponse> {
    return this.mfaService.verifyMfaSetup(
      this.resolveMfaSubject(context, input.mfaSetupToken),
      input.code,
    );
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
  // MFA Step-Up (Authenticated — elevates existing session)
  // ==========================================================================

  /**
   * IP-2: MFA step-up authentication.
   *
   * Called when an authenticated user needs to re-verify identity for
   * sensitive operations (impersonation, cross-tenant access, billing changes).
   * Returns new tokens with mfaVerified=true claim.
   *
   * SECURITY: Requires a valid access token (user must already be logged in).
   * The TOTP code is verified against the user's MFA secret.
   */
  @SkipTenantGuard()
  @Mutation(() => AuthPayload, { description: 'MFA step-up: re-verify identity for elevated operations' })
  async mfaStepUp(
    @CurrentUser('sub') userId: string,
    @Args('input') input: MfaStepUpInput,
    @Context() context: GqlContext,
  ): Promise<AuthPayload> {
    const forwarded = context.req?.headers?.['x-forwarded-for'];
    const ipAddress = context.req?.ip || (Array.isArray(forwarded) ? forwarded[0] : forwarded);
    const userAgent = context.req?.headers?.['user-agent'] as string | undefined;

    const result = await this.mfaService.verifyStepUp(
      userId,
      input.code,
      ipAddress,
      userAgent,
    );

    // Step-up elevates an already-authenticated session; it is not a "remember
    // me" login → session cookie.
    this.setRefreshTokenCookie(context.res, result.refreshToken, false);
    return this.stripRefreshToken(result);
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
  // SECURITY (SEC-CRITICAL-002): a 6-digit TOTP space MUST be velocity
  // limited at the service. Keying by the challenge token caps guesses per
  // login session at 5 — rotating IPs buys an attacker nothing.
  @RateLimit({
    name: 'mfa-verify',
    limit: 5,
    windowMs: 15 * 60_000,
    identifier: ({ args }) =>
      (args?.['input'] as { mfaToken?: string } | undefined)?.mfaToken || undefined,
  })
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

    // Set refresh token as httpOnly cookie, honoring the rememberMe choice the
    // user made at the password step (carried through the signed mfaToken).
    this.setRefreshTokenCookie(context.res, result.refreshToken, result.rememberMe ?? false);
    return this.stripRefreshToken(result);
  }
}
