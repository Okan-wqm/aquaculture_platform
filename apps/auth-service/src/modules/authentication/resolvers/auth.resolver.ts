import { UseGuards } from '@nestjs/common';
import { Resolver, Mutation, Args, Query, Context } from '@nestjs/graphql';
import { CurrentUser, Public } from '@platform/backend-common';

import {
  AuthPayload,
  LogoutResponse,
  TokenValidationResponse,
  MePayload,
  InvitationValidationResponse,
} from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { RefreshTokenInput } from '../dto/refresh-token.dto';
import { RegisterInput } from '../dto/register.dto';
import { User } from '../entities/user.entity';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticationService } from '../services/authentication.service';


@Resolver(() => User)
export class AuthResolver {
  constructor(private readonly authService: AuthenticationService) {}

  @Public()
  @Mutation(() => AuthPayload)
  async register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    return this.authService.register(input);
  }

  @Public()
  @Mutation(() => AuthPayload)
  async login(
    @Args('input') input: LoginInput,
    @Context() context: { req: Request & { ip?: string; headers: Record<string, string> } },
  ): Promise<AuthPayload> {
    const request = context.req;
    const ipAddress = request.ip || request.headers['x-forwarded-for'];
    const userAgent = request.headers['user-agent'];
    return this.authService.login(input, ipAddress, userAgent);
  }

  @Public()
  @Mutation(() => AuthPayload)
  async refreshToken(@Args('input') input: RefreshTokenInput): Promise<AuthPayload> {
    return this.authService.refreshToken(input.refreshToken);
  }

  /**
   * Accept invitation and set password
   */
  @Public()
  @Mutation(() => AuthPayload)
  async acceptInvitation(
    @Args('token') token: string,
    @Args('password') password: string,
    @Args('firstName', { nullable: true }) firstName?: string,
    @Args('lastName', { nullable: true }) lastName?: string,
    @Context() context?: { req: Request & { ip?: string; headers: Record<string, string> } },
  ): Promise<AuthPayload> {
    const ipAddress = context?.req?.ip || context?.req?.headers?.['x-forwarded-for'];
    return this.authService.acceptInvitation(token, password, firstName, lastName, ipAddress);
  }

  /**
   * Validate invitation token (to show accept form)
   */
  @Public()
  @Query(() => InvitationValidationResponse)
  async validateInvitation(@Args('token') token: string): Promise<InvitationValidationResponse> {
    return this.authService.validateInvitation(token);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => LogoutResponse)
  async logout(@CurrentUser('sub') userId: string): Promise<LogoutResponse> {
    const success = await this.authService.logout(userId);
    return { success, message: success ? 'Logged out successfully' : 'Logout failed' };
  }

  /**
   * Get current user profile with accessible modules and redirect path
   */
  @UseGuards(JwtAuthGuard)
  @Query(() => MePayload)
  async me(@CurrentUser('sub') userId: string): Promise<MePayload> {
    return this.authService.me(userId);
  }

  /**
   * Get current user entity only (simplified version)
   */
  @UseGuards(JwtAuthGuard)
  @Query(() => User)
  async currentUser(@CurrentUser('sub') userId: string): Promise<User> {
    const user = await this.authService.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }

  @Public()
  @Query(() => TokenValidationResponse)
  async validateToken(@Args('token') token: string): Promise<TokenValidationResponse> {
    const result = await this.authService.validateToken(token);
    if (!result.valid || !result.payload) {
      return { valid: false };
    }
    return {
      valid: true,
      userId: result.payload.sub,
      tenantId: result.payload.tenantId ?? undefined,
      role: result.payload.role,
      expiresAt: new Date((result.payload as unknown as { exp: number }).exp * 1000),
    };
  }
}
