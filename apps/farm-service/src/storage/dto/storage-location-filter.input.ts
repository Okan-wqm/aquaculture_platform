import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { StorageLocationType } from '../entities/storage-location.entity';

@InputType()
export class StorageLocationFilterInput {
  @Field(() => StorageLocationType, { nullable: true })
  @IsOptional()
  @IsEnum(StorageLocationType)
  type?: StorageLocationType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
