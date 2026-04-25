/**
 * SupplierSite GraphQL response type — Scope A Phase 4.4.2.
 *
 * Mirrors the entity at apps/farm-service/src/supplier/entities/supplier-site.entity.ts.
 * The `siteId` and `supplierId` are exposed as `ID` for GraphQL but
 * the joined Site/Supplier objects are NOT field-resolved here — the
 * caller queries them via the `Supplier.approvedSites` field
 * resolver and the existing `site(id: ID!)` query when needed. This
 * keeps the SupplierSite response narrow and avoids N+1 fan-out from
 * a list query.
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class SupplierSiteResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field(() => ID)
  supplierId!: string;

  @Field(() => ID)
  siteId!: string;

  @Field()
  isPreferred!: boolean;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt!: Date;

  @Field({ nullable: true })
  createdBy?: string;
}
