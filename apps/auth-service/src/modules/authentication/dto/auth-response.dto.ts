import { ObjectType, Field, Int } from '@nestjs/graphql';
import { User } from '../entities/user.entity';
import { Role } from '@platform/backend-common';

@ObjectType()
export class AuthPayload {
  @Field()
  accessToken: string;

  @Field()
  refreshToken: string;

  @Field(() => User)
  user: User;

  @Field(() => Int)
  expiresIn: number;

  @Field()
  tokenType: string;

  /**
   * Redirect URL based on user role after login
   * - SUPER_ADMIN: /admin/dashboard
   * - TENANT_ADMIN: /tenant/dashboard
   * - MODULE_MANAGER/MODULE_USER: module's defaultRoute or /no-access
   */
  @Field()
  redirectUrl: string;
}

@ObjectType()
export class UserModule {
  @Field()
  code: string;

  @Field()
  name: string;

  @Field()
  defaultRoute: string;
}

@ObjectType()
export class MePayload {
  @Field(() => User)
  user: User;

  @Field(() => [UserModule])
  modules: UserModule[];

  @Field()
  redirectPath: string;
}

@ObjectType()
export class LogoutResponse {
  @Field()
  success: boolean;

  @Field(() => String, { nullable: true })
  message?: string;
}

@ObjectType()
export class TokenValidationResponse {
  @Field()
  valid: boolean;

  @Field(() => String, { nullable: true })
  userId?: string;

  @Field(() => String, { nullable: true })
  tenantId?: string;

  @Field(() => Role, { nullable: true })
  role?: Role;

  @Field(() => String, { nullable: true })
  expiresAt?: Date;
}

@ObjectType()
export class InvitationValidationResponse {
  @Field()
  valid: boolean;

  @Field(() => String, { nullable: true })
  email?: string;

  @Field(() => Role, { nullable: true })
  role?: Role;

  @Field(() => String, { nullable: true })
  firstName?: string;

  @Field(() => String, { nullable: true })
  lastName?: string;

  @Field(() => String, { nullable: true })
  expired?: boolean;
}
