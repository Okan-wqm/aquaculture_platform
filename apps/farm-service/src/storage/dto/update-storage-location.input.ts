import { InputType, Field, ID, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateStorageLocationInput } from './create-storage-location.input';
import { StorageLocationType } from '../entities/storage-location.entity';

@InputType()
export class UpdateStorageLocationInput extends PartialType(CreateStorageLocationInput) {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

  @Field(() => StorageLocationType, { nullable: true })
  @IsOptional()
  @IsEnum(StorageLocationType)
  type?: StorageLocationType;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
