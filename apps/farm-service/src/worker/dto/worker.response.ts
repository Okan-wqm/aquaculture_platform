import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class WorkerResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  employeeNumber!: string;

  @Field()
  firstName!: string;

  @Field()
  lastName!: string;

  @Field()
  email!: string;

  @Field({ nullable: true })
  phone?: string;

  @Field()
  department!: string;

  @Field()
  position!: string;

  @Field()
  isVeterinarian!: boolean;

  @Field({ nullable: true })
  veterinaryLicenseNumber?: string;

  @Field()
  status!: string;

  @Field()
  hireDate!: Date;

  @Field()
  createdAt!: Date;
}
