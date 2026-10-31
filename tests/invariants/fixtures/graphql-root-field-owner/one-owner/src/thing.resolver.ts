// Fixture subgraph for graphql-root-field-single-owner.spec.ts: `thing` has one
// resolver method.
import { Field, ID, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType()
export class FixtureThing {
  @Field(() => ID)
  id!: string;
}

@Resolver(() => FixtureThing)
export class ThingResolver {
  @Query(() => FixtureThing, { name: 'thing', nullable: true })
  thing(): FixtureThing | null {
    return null;
  }
}
