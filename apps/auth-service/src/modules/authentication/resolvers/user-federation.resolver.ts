import { Resolver, ResolveReference } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../entities/user.entity';

/**
 * Apollo Federation reference resolver for the `User` entity (MSG-MEDIUM-052).
 *
 * WHY: messaging-service (and other subgraphs) carry a `User` reference (e.g.
 * `Message.sender`) keyed by `id`; the gateway resolves the display fields here.
 * Previously messaging returned placeholder nulls for sender names, so the chat
 * UI showed blank senders/avatars everywhere.
 *
 * SECURITY (display-only boundary): the reference resolver loads and returns ONLY
 * display-safe fields (`id`, `firstName`, `lastName`, `profileImageUrl`). Because
 * `email`/`role`/`tenantId` are NOT selected, they are `undefined` on the resolved
 * object and a federated `sender { email }` query resolves to null — a channel
 * member cannot harvest another member's email through the messaging path. auth's
 * own admin-gated queries (e.g. `tenantUsers`) still return `email` because they
 * resolve `User` directly, not via this reference resolver. The userId in the
 * reference is already authorized upstream (the caller is a member of the channel
 * whose sender/member this is), so a bare id lookup is the correct scope.
 */
@Resolver(() => User)
export class UserFederationResolver {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  @ResolveReference()
  async resolveReference(reference: {
    __typename: string;
    id: string;
  }): Promise<User | null> {
    return this.userRepo.findOne({
      where: { id: reference.id },
      // Display-only projection — email/role/tenantId are intentionally NOT loaded.
      select: {
        id: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
      },
    });
  }
}
