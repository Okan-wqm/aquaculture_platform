import { Resolver, Query, ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
class HydroponicsStatusResponse {
  @Field()
  configured!: boolean;

  @Field()
  moduleName!: string;
}

@Resolver()
export class SetupResolver {
  @Query(() => HydroponicsStatusResponse, { description: 'Get hydroponics module status' })
  async hydroponicsStatus(): Promise<HydroponicsStatusResponse> {
    return {
      configured: false,
      moduleName: 'Hydroponics Management',
    };
  }
}
