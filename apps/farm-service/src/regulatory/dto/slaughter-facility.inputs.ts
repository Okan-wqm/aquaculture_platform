/**
 * Slaughter-facility catalog inputs. The godkjenningsnummer format (1–6
 * alphanumeric) mirrors the official slakt report schemas — an unusable
 * approval number is rejected at the catalog boundary, not at submit time.
 */
import { Field, ID, InputType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export const GODKJENNINGSNUMMER_PATTERN = /^[A-Za-z0-9]{1,6}$/;

@InputType()
export class CreateSlaughterFacilityInput {
  @Field()
  @IsString()
  @MaxLength(150)
  name!: string;

  @Field({ description: 'Official approval number (1–6 alphanumeric)' })
  @Matches(GODKJENNINGSNUMMER_PATTERN, {
    message: 'godkjenningsnummer must be 1–6 alphanumeric characters',
  })
  godkjenningsnummer!: string;

  @Field({ defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;
}

@InputType()
export class UpdateSlaughterFacilityInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @Matches(GODKJENNINGSNUMMER_PATTERN, {
    message: 'godkjenningsnummer must be 1–6 alphanumeric characters',
  })
  godkjenningsnummer?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
