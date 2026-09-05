import { Args, ID, Query, Resolver, ResolveReference } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, CurrentUser, Role } from '@aquaculture/backend-common/decorators';

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
 * SEC-MEDIUM-097 (2026-08-23 scan №42): the projection loads ONLY
 * PublicUserProfile fields, but the lookup itself was tenant-UNSCOPED — a bare
 * id resolved ANY platform user's name/avatar (cross-tenant read + a
 * null-vs-data enumeration oracle). Display references only ever point
 * in-tenant (channels, messages and presence are tenant-scoped), so lookups
 * are scoped by the CALLING user's tenant. SUPER_ADMIN keeps the cross-tenant
 * platform view; a tenantless non-admin fails closed (null).
 */
@Resolver(() => PublicUserProfile)
export class PublicUserProfileFederationResolver {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /**
   * Public (display-only, no-PII) profile by id, scoped to the caller's
   * tenant. Two jobs: (1) a genuine lookup the client uses for @mentions /
   * member displays, and (2) it makes PublicUserProfile a REACHABLE root type
   * so it emits into the subgraph SDL — the code-first SDL emitter
   * (tools/scripts/emit-subgraph-sdl.ts) builds with orphanedTypes:[] and
   * would otherwise drop a reference-only entity, so the composed supergraph
   * would carry PublicUserProfile without its display fields.
   */
  @Query(() => PublicUserProfile, { nullable: true, name: 'publicUserProfile' })
  async publicUserProfile(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string | null,
    @CurrentUser('roles') roles: string[] | undefined,
  ): Promise<PublicUserProfile | null> {
    return this.lookupScoped(id, tenantId, roles);
  }

  @ResolveReference()
  async resolveReference(
    reference: {
      __typename: string;
      id: string;
    },
    context?: { req?: { user?: { tenantId?: string | null; roles?: string[] } } },
  ): Promise<PublicUserProfile | null> {
    const caller = context?.req?.user;
    return this.lookupScoped(reference.id, caller?.tenantId ?? null, caller?.roles);
  }

  /**
   * Tenant-scoped display lookup shared by the root query and the federation
   * reference path. SUPER_ADMIN resolves platform-wide; everyone else is
   * confined to their own tenant; tenantless non-admins get null.
   */
  private async lookupScoped(
    id: string,
    tenantId: string | null,
    roles: string[] | undefined,
  ): Promise<PublicUserProfile | null> {
    // Display-only projection — email/role/tenantId are never loaded.
    const select = {
      id: true,
      firstName: true,
      lastName: true,
      profileImageUrl: true,
    } as const;

    if (roles?.includes(Role.SUPER_ADMIN) === true) {
      const user = await this.userRepo.findOne({ where: { id }, select });
      return user ? this.toProfile(user) : null;
    }

    if (!tenantId) {
      // Tenantless non-admin callers get no cross-tenant display data.
      return null;
    }

    const user = await this.userRepo.findOne({ where: { id, tenantId }, select });
    return user ? this.toProfile(user) : null;
  }

  private toProfile(
    user: Pick<User, 'id' | 'firstName' | 'lastName' | 'profileImageUrl'>,
  ): PublicUserProfile {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImageUrl: user.profileImageUrl,
    };
  }
}
