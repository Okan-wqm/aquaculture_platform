// Claims `thing` again — the shape sensor's two `sensor(id)` queries had.
import { Query, Resolver } from '@nestjs/graphql';

import { FixtureThing } from './thing.resolver';

@Resolver(() => FixtureThing)
export class OtherResolver {
  @Query(() => FixtureThing, { name: 'thing', nullable: true })
  findThing(): FixtureThing | null {
    return null;
  }
}
