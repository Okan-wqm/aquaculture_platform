/**
 * Chemical Response Types for GraphQL
 */
import { ObjectType, Field, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import { ChemicalType, ChemicalStatus } from '../entities/chemical.entity';

// Register enums for GraphQL
registerEnumType(ChemicalType, {
  name: 'ChemicalType',
  description: 'Type of chemical',
});

registerEnumType(ChemicalStatus, {
  name: 'ChemicalStatus',
  description: 'Status of the chemical',
});

@ObjectType()
export class ChemicalTypeResponse {
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
export class FirstAidInfoResponse {
  @Field({ nullable: true })
  inhalation?: string;

  @Field({ nullable: true })
  skinContact?: string;

  @Field({ nullable: true })
  eyeContact?: string;

  @Field({ nullable: true })
  ingestion?: string;
}

@ObjectType()
export class ChemicalSafetyInfoResponse {
  @Field({ nullable: true })
  hazardClass?: string;

  @Field({ nullable: true })
  signalWord?: string;

  @Field(() => [String], { nullable: true })
  hazardStatements?: string[];

  @Field(() => [String], { nullable: true })
  precautionaryStatements?: string[];

  @Field(() => FirstAidInfoResponse, { nullable: true })
  firstAid?: FirstAidInfoResponse;

  @Field({ nullable: true })
  storageConditions?: string;

  @Field({ nullable: true })
  disposalMethod?: string;

  @Field({ nullable: true })
  msdsUrl?: string;
}

@ObjectType()
export class UsageProtocolResponse {
  @Field({ nullable: true })
  dosage?: string;

  @Field({ nullable: true })
  applicationMethod?: string;

  @Field({ nullable: true })
  frequency?: string;

  @Field({ nullable: true })
  duration?: string;

  @Field(() => Int, { nullable: true })
  withdrawalPeriod?: number;

  @Field(() => [String], { nullable: true })
  targetSpecies?: string[];

  @Field(() => [String], { nullable: true })
  targetConditions?: string[];

  @Field(() => [String], { nullable: true })
  contraindications?: string[];

  @Field(() => [String], { nullable: true })
  precautions?: string[];

  @Field({ nullable: true })
  notes?: string;
}

@ObjectType()
export class ChemicalDocumentResponse {
  @Field({ nullable: true })
  id?: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  type?: string;

  @Field({ nullable: true })
  url?: string;

  @Field({ nullable: true })
  uploadedAt?: string;

  @Field({ nullable: true })
  uploadedBy?: string;
}

@ObjectType()
export class ChemicalResponse {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  tenantId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => ChemicalType)
  type!: ChemicalType;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  brand?: string;

  @Field({ nullable: true })
  activeIngredient?: string;

  @Field({ nullable: true })
  concentration?: string;

  @Field({ nullable: true })
  formulation?: string;

  @Field(() => ID, { nullable: true })
  supplierId?: string;

  @Field(() => ChemicalStatus)
  status!: ChemicalStatus;

  @Field(() => Float)
  quantity!: number;

  @Field(() => Float)
  minStock!: number;

  @Field()
  unit!: string;

  @Field(() => UsageProtocolResponse, { nullable: true })
  usageProtocol?: UsageProtocolResponse;

  @Field(() => ChemicalSafetyInfoResponse, { nullable: true })
  safetyInfo?: ChemicalSafetyInfoResponse;

  @Field({ nullable: true })
  storageRequirements?: string;

  @Field(() => Int, { nullable: true })
  shelfLifeMonths?: number;

  @Field({ nullable: true })
  expiryDate?: Date;

  @Field(() => [String], { nullable: true })
  usageAreas?: string[];

  @Field(() => [ChemicalDocumentResponse], { nullable: true })
  documents?: ChemicalDocumentResponse[];

  @Field(() => Float, { nullable: true })
  unitPrice?: number;

  @Field()
  currency!: string;

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
export class PaginatedChemicalsResponse {
  @Field(() => [ChemicalResponse])
  items!: ChemicalResponse[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  totalPages!: number;
}
