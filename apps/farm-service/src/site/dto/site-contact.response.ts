/**
 * SiteContact GraphQL response — Scope A Phase 4.4.3.
 *
 * Mirrors the entity at apps/farm-service/src/site/entities/site-contact.entity.ts.
 * The joined Site is NOT field-resolved here — clients fetch the
 * site via the existing `site(id)` query when needed; this response
 * stays narrow.
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class SiteContactResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID)
  siteId!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  role?: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field()
  isPrimary!: boolean;

  @Field()
  createdAt!: Date;

  @Field({ nullable: true })
  createdBy?: string;
}
