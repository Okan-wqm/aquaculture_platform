import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsEmail, MaxLength } from 'class-validator';

@InputType()
export class CreateWorkerInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  firstName!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @Field()
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  position!: string;
}
