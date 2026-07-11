import { Directive, Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * PublicUserProfile — the display-only, cross-subgraph representation of a user.
 *
 * SSoT + make-it-impossible (supersedes the MSG-MEDIUM-052 nullable-null design):
 * auth-service owns user identity and exposes TWO federated shapes of it —
 *
 *   - `User`            the AUTHENTICATED principal (id, email, role, tenantId +
 *                       display fields). Returned ONLY by auth's own self/admin
 *                       queries (currentUser, tenantUsers, login/register payloads).
 *                       `email` stays non-null there because it is never resolved
 *                       over a federated reference.
 *   - `PublicUserProfile` the PUBLIC profile that OTHER subgraphs reference by `id`
 *                       (messaging `Message.sender`, `ChannelMember.user`,
 *                       userPresence, channelEligibleUsers). It STRUCTURALLY omits
 *                       email/role/tenantId.
 *
 * Because a message sender / channel member is a `PublicUserProfile`, the `email`
 * field does not exist on it — a channel member can never harvest another member's
 * email through a federated `sender { email }` (the query fails schema validation,
 * not at runtime), and there is no non-nullable-field-resolves-null crash. The
 * privacy boundary is enforced by the type system, not by a nullable widening.
 */
@ObjectType()
@Directive('@key(fields: "id")')
export class PublicUserProfile {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  firstName?: string | null;

  @Field(() => String, { nullable: true })
  lastName?: string | null;

  @Field(() => String, { nullable: true })
  profileImageUrl?: string | null;
}
