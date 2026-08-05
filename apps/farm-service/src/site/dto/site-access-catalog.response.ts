import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * Minimal farm-owned Site projection used by tenant site-access management.
 * Keeping this separate from SiteResponse prevents the administration surface
 * from depending on operational Site fields it neither needs nor owns.
 */
@ObjectType()
export class SiteAccessCatalogItemResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;
}
