import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsNumber, MaxLength, MinLength, IsEnum, IsUUID } from 'class-validator';
import { StorageLocationType } from '../entities/storage-location.entity';

@InputType()
export class CreateStorageLocationInput {
  @Field(() => ID)
  @IsUUID()
  siteId!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @Field(() => StorageLocationType)
  @IsEnum(StorageLocationType)
  type!: StorageLocationType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  capacity?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  capacityUnit?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  temperatureMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  temperatureMax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  humidityMin?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  humidityMax?: number;
}
