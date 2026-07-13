import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Role } from '@aquaculture/backend-common/decorators';

import { User } from '../entities/user.entity';

@ObjectType()
export class AuthPayload {
  @Field()
  accessToken!: string;

  // SEC-HIGH-008 cure: machine-readable deprecation. The
  // deprecationReason flows into GraphQL SDL as
  // @deprecated(reason: ...) — IDE plugins surface a warning, codegen
  // emits a deprecation comment, and federation gateways propagate
  // the signal. Description-text-only deprecation never reached
  // frontend codegen tooling. Refresh-token transport moved to
  // httpOnly cookie; the field stays nullable+empty until the next
  // release sunset, then deletes.
  @Field({
    description:
      'Deprecated: refresh token is now stored in httpOnly cookie. This field returns empty string.',
    deprecationReason:
      'Refresh token is now in httpOnly cookie; this field returns empty string and will be removed in the next release. Read the cookie via the auth flow instead.',
  })
  refreshToken!: string;

  @Field(() => User)
  user!: User;

  @Field(() => Int)
  expiresIn!: number;

  @Field()
  tokenType!: string;

  /**
   * Redirect URL based on user role after login
   * - SUPER_ADMIN: /admin/dashboard
   * - TENANT_ADMIN: /tenant/dashboard
   * - MODULE_MANAGER/MODULE_USER: module's defaultRoute or /no-access
   */
  @Field()
  redirectUrl!: string;

  /**
   * When true, the user has MFA enabled and must complete MFA verification.
   * In this case, accessToken/refreshToken are empty and mfaToken is provided.
   */
  @Field(() => Boolean, { nullable: true })
  mfaRequired?: boolean;

  /**
   * Short-lived JWT token for MFA verification step (5 min TTL).
   * Only present when mfaRequired=true.
   */
  @Field(() => String, { nullable: true })
  mfaToken?: string;

  /**
   * ADR-042: when true, the tenant enforces MFA and this user has none
   * enrolled. accessToken/refreshToken are empty; mfaSetupToken is provided so
   * the user can complete enrollment (setupMfa + verifyMfaSetup) and then log
   * in again. A completable path — not a lockout.
   */
  @Field(() => Boolean, { nullable: true })
  mfaSetupRequired?: boolean;

  /**
   * ADR-042: short-lived (10 min) JWT (type 'mfa_setup') that authorizes ONLY
   * setupMfa + verifyMfaSetup for this user. Rejected as a bearer credential
   * everywhere (enforceAccessTokenType) and rejected by verifyMfaLogin.
   * Only present when mfaSetupRequired=true.
   */
  @Field(() => String, { nullable: true })
  mfaSetupToken?: string;

  /**
   * INTERNAL transport only — NOT a @Field, so it never enters the GraphQL SDL
   * or client codegen. Carries the session's "remember me" choice back to the
   * resolver so it can branch the refresh-cookie maxAge (persistent vs session).
   * The resolver reads it and never returns it to the client.
   */
  rememberMe?: boolean;
}

@ObjectType()
export class UserModule {
  @Field()
  code!: string;

  @Field()
  name!: string;

  @Field()
  defaultRoute!: string;
}

@ObjectType()
export class MePayload {
  @Field(() => User)
  user!: User;

  @Field(() => [UserModule])
  modules!: UserModule[];

  @Field()
  redirectPath!: string;
}

@ObjectType()
export class LogoutResponse {
  @Field()
  success!: boolean;

  @Field(() => String, { nullable: true })
  message?: string;
}

@ObjectType()
export class TokenValidationResponse {
  @Field()
  valid!: boolean;

  @Field(() => String, { nullable: true })
  userId?: string;

  @Field(() => String, { nullable: true })
  tenantId?: string;

  @Field(() => Role, { nullable: true })
  role?: Role;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date;
}

@ObjectType()
export class InvitationValidationResponse {
  @Field()
  valid!: boolean;

  @Field(() => String, { nullable: true })
  email?: string;

  @Field(() => Role, { nullable: true })
  role?: Role;

  @Field(() => String, { nullable: true })
  firstName?: string;

  @Field(() => String, { nullable: true })
  lastName?: string;

  @Field(() => Boolean, { nullable: true })
  expired?: boolean;
}
