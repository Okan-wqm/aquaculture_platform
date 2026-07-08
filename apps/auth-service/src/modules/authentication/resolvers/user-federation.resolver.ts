import { Resolver, ResolveReference } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PublicUserProfile } from '../entities/public-user-profile.type';
import { User } from '../entities/user.entity';

/**
 * Apollo Federation reference resolver for `PublicUserProfile` (SSoT split,
 * supersedes MSG-MEDIUM-052's null-over-non-nullable design).
 *
 * WHY: messaging-service (and any other subgraph) reference a user for DISPLAY
 * (`Message.sender`, `ChannelMember.user`, userPresence) keyed by `id`. They now
 * reference the display-only `PublicUserProfile` type — which structurally has NO
 * email/role/tenantId — instead of the authenticated `User`. So the privacy
 * boundary is enforced by the type system: a federated `sender { email }` is a
 * schema error, not a runtime null. auth's own admin-gated queries still resolve
 * the full `User` (with email) directly, never through this reference resolver.
 *
 * The projection loads ONLY the PublicUserProfile fields. The userId in the
 * reference is already authorized upstream (the caller is a member of the channel
 * whose sender/member this is), so a bare id lookup is the correct scope.
 */
@Resolver(() => PublicUserProfile)
export class PublicUserProfileFederationResolver {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  @ResolveReference()
  async resolveReference(reference: {
    __typename: string;
    id: string;
  }): Promise<PublicUserProfile | null> {
    const user = await this.userRepo.findOne({
      where: { id: reference.id },
      // Display-only projection — email/role/tenantId are never loaded here.
      select: {
        id: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
      },
    });
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
    };
  }
}
