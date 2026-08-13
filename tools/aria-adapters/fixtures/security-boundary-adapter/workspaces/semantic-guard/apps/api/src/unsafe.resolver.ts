import { Mutation, Resolver } from '@nestjs/graphql';
@Resolver()
export class UnsafeResolver {
  @Mutation(() => Boolean)
  mutate() {
    return true;
  }
}
