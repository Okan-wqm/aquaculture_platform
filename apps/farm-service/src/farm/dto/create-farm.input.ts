import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNumber,
  MinLength,
  MaxLength,
  IsEmail,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';

/**
 * Location input for farm creation
 */
@InputType()
export class LocationInput {
  @Field(() => Float)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;
}

/**
 * Create Farm Input DTO
 */
@InputType()
export class CreateFarmInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @Field(() => LocationInput)
  location: LocationInput;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  contactPerson?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  contactPhone?: string;

  @Field({ nullable: true })
  @IsEmail()
  @IsOptional()
  contactEmail?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  totalArea?: number;
}
