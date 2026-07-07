import { InputType, Field, ID } from '@nestjs/graphql';
import { IsBoolean, IsUUID, IsOptional, IsString, IsEmail, MaxLength } from 'class-validator';

@InputType()
export class UpdateWorkerInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isVeterinarian?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  veterinaryLicenseNumber?: string;
}
