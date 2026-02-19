import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
export class HydroponicsStatusResponse {
  @Field()
  configured!: boolean;

  @Field()
  moduleName!: string;
}
