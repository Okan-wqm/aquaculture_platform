/**
 * Supplier Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { SupplierType, SupplierStatus } from '../entities/supplier.entity';

// Register enums for GraphQL
registerEnumType(SupplierType, {
  name: 'SupplierType',
  description: 'Type of supplier',
});

registerEnumType(SupplierStatus, {
  name: 'SupplierStatus',
  description: 'Status of the supplier',
});

@ObjectType()
export class SupplierTypeResponse {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  icon?: string;

  @Field()
  isActive!: boolean;

  @Field(() => Int)
  sortOrder!: number;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class SupplierContactResponse {
  @Field()
  name!: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true })
  department?: string;

  @Field({ nullable: true })
  isPrimary?: boolean;
}

@ObjectType()
export class SupplierAddressResponse {
  @Field({ nullable: true })
  street?: string;

  @Field()
  city!: string;

  @Field({ nullable: true })
  state?: string;

  @Field({ nullable: true })
  postalCode?: string;

  @Field()
  country!: string;
}

@ObjectType()
export class PaymentTermsResponse {
  @Field(() => Int)
  paymentDays!: number;

  @Field(() => Float, { nullable: true })
  creditLimit?: number;

  @Field()
  currency!: string;

  @Field(() => Float, { nullable: true })
  discountPercent?: number;

  @Field(() => Int, { nullable: true })
  discountDays?: number;

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
export class SupplierResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => SupplierType)
  type!: SupplierType;

  @Field({ nullable: true })
  description?: string;

  @Field(() => [String], { nullable: true })
  categories?: string[];

  @Field(() => [String], { nullable: true })
  products?: string[];

  @Field({ nullable: true })
  contactPerson?: string;

  @Field({ nullable: true })
  city?: string;

  @Field(() => SupplierStatus)
  status!: SupplierStatus;

  @Field(() => SupplierContactResponse, { nullable: true })
  primaryContact?: SupplierContactResponse;

  @Field(() => [SupplierContactResponse], { nullable: true })
  contacts?: SupplierContactResponse[];

  @Field({ nullable: true })
  email?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true })
  fax?: string;

  @Field({ nullable: true })
  website?: string;

  @Field(() => SupplierAddressResponse, { nullable: true })
  address?: SupplierAddressResponse;

  @Field({ nullable: true })
  country?: string;

  @Field({ nullable: true })
  taxNumber?: string;

  @Field(() => PaymentTermsResponse, { nullable: true })
  paymentTerms?: PaymentTermsResponse;

  @Field(() => Float, { nullable: true })
  rating?: number;

  @Field(() => [String], { nullable: true })
  certifications?: string[];

  @Field({ nullable: true })
  notes?: string;

  @Field()
  isActive!: boolean;

  @Field(() => ID, { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  updatedBy?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@ObjectType()
export class PaginatedSuppliersResponse {
  @Field(() => [SupplierResponse])
  items!: SupplierResponse[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}
