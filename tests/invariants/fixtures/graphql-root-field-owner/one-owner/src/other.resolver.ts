// A second resolver that serves its own root field, as most subgraphs have.
import { Query, Resolver } from '@nestjs/graphql';

import { FixtureThing } from './thing.resolver';

@Resolver(() => FixtureThing)
export class OtherResolver {
  @Query(() => [FixtureThing], { name: 'things' })
  things(): FixtureThing[] {
    return [];
  }
}
