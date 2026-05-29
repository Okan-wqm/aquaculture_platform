import { CurrentUser, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import {
  ChangeMyPasswordInput,
  ChangeMyPasswordResponse,
  ChangePasswordInput,
  MySecuritySettings,
  UpdateMyProfileInput,
  UpdateProfileInput,
} from '../dto/account.dto';
import { User } from '../entities/user.entity';
import { AccountService } from '../services/account.service';

@Resolver(() => User)
export class AccountResolver {
  constructor(private readonly accountService: AccountService) {}

  @SkipTenantGuard()
  @Mutation(() => User)
  async updateMyProfile(
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateMyProfileInput,
  ): Promise<User> {
    return this.accountService.updateMyProfile(userId, input);
  }

  @SkipTenantGuard()
  @Mutation(() => User, {
    name: 'updateProfile',
    deprecationReason: 'Use updateMyProfile. This compatibility alias will be removed after rollout.',
  })
  async updateProfileAlias(
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateProfileInput,
  ): Promise<User> {
    const { email, firstName, lastName } = input;
    return this.accountService.updateMyProfile(userId, { firstName, lastName }, { email });
  }

  @SkipTenantGuard()
  @Mutation(() => ChangeMyPasswordResponse)
  async changeMyPassword(
    @CurrentUser('sub') userId: string,
    @Args('input') input: ChangeMyPasswordInput,
  ): Promise<ChangeMyPasswordResponse> {
    return this.accountService.changeMyPassword(userId, input);
  }

  @SkipTenantGuard()
  @Mutation(() => ChangeMyPasswordResponse, {
    name: 'changePassword',
    deprecationReason: 'Use changeMyPassword. This compatibility alias will be removed after rollout.',
  })
  async changePasswordAlias(
    @CurrentUser('sub') userId: string,
    @Args('input') input: ChangePasswordInput,
  ): Promise<ChangeMyPasswordResponse> {
    return this.accountService.changeMyPassword(userId, input);
  }

  @SkipTenantGuard()
  @Query(() => MySecuritySettings)
  async mySecuritySettings(@CurrentUser('sub') userId: string): Promise<MySecuritySettings> {
    return this.accountService.getMySecuritySettings(userId);
  }
}
