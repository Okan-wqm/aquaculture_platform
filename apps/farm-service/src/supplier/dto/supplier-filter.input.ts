/**
 * Supplier Filter Input DTO
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum } from 'class-validator';
import { SupplierType, SupplierStatus } from '../entities/supplier.entity';

@InputType()
export class SupplierFilterInput {
  @Field(() => SupplierType, { nullable: true })
  @IsOptional()
  @IsEnum(SupplierType)
  type?: SupplierType;

  @Field(() => SupplierStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  country?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
