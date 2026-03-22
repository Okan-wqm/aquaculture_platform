import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Role } from '@aquaculture/backend-common';

import { User } from '../entities/user.entity';

@ObjectType()
export class AuthPayload {
  @Field()
  accessToken!: string;

  @Field({ description: 'Deprecated: refresh token is now stored in httpOnly cookie. This field returns empty string.' })
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
