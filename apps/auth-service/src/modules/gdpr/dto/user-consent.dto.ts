import { Field, HideField, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ConsentType } from '@aquaculture/backend-common/security';

// Register the ConsentType enum for GraphQL
registerEnumType(ConsentType, {
  name: 'ConsentType',
  description: 'Types of consent that can be granted or withdrawn',
});

// ============================================================================
// Input DTOs
// ============================================================================

/**
 * Input for recording a single consent
 */
@InputType()
export class RecordConsentInput {
  @Field(() => ConsentType)
  @IsEnum(ConsentType)
  consentType!: ConsentType;

  @Field()
  @IsNotEmpty()
  granted!: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;
}

/**
 * Input for recording multiple consents at once
 */
@InputType()
export class RecordBulkConsentInput {
  @Field(() => [ConsentItemInput])
  consents!: ConsentItemInput[];
}

/**
 * Single consent item for bulk operations
 */
@InputType()
export class ConsentItemInput {
  @Field(() => ConsentType)
  @IsEnum(ConsentType)
  consentType!: ConsentType;

  @Field()
  @IsNotEmpty()
  granted!: boolean;
}

/**
 * Input for withdrawing consent
 */
@InputType()
export class WithdrawConsentInput {
  @Field(() => ConsentType)
  @IsEnum(ConsentType)
  consentType!: ConsentType;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ============================================================================
// Output DTOs
// ============================================================================

/**
 * Represents a single consent record
 */
@ObjectType()
export class UserConsentRecord {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID, { nullable: true })
  tenantId?: string | null;

  @Field(() => ConsentType)
  consentType!: ConsentType;

  @Field()
  granted!: boolean;

  @Field()
  version!: string;

  // SECURITY: IP addresses are PII under GDPR — hidden from GraphQL response (FINDING-027)
  // Retained in the database for audit purposes
  @HideField()
  ipAddress?: string | null;

  // SECURITY: User agents can be used for fingerprinting — hidden from GraphQL response
  @HideField()
  userAgent?: string | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;

  @Field()
  isActive!: boolean;
}

/**
 * Current consent status for a user showing all consent types
 */
@ObjectType()
export class UserConsentStatus {
  @Field(() => ID)
  userId!: string;

  @Field(() => Date)
  lastUpdated!: Date;

  @Field()
  consentVersion!: string;

  @Field()
  isOutdated!: boolean;

  @Field(() => [ConsentStatusItem])
  consents!: ConsentStatusItem[];
}

/**
 * Status of a single consent type
 */
@ObjectType()
export class ConsentStatusItem {
  @Field(() => ConsentType)
  consentType!: ConsentType;

  @Field()
  granted!: boolean;
}

/**
 * Result of recording consent
 */
@ObjectType()
export class RecordConsentResult {
  @Field(() => ID)
  id!: string;

  @Field()
  success!: boolean;

  @Field()
  message!: string;
}

/**
 * Result of bulk consent recording
 */
@ObjectType()
export class BulkConsentResult {
  @Field(() => [ID])
  ids!: string[];

  @Field()
  success!: boolean;

  @Field()
  message!: string;

  @Field()
  recordedCount!: number;
}

/**
 * Result of consent withdrawal
 */
@ObjectType()
export class WithdrawConsentResult {
  @Field()
  success!: boolean;

  @Field()
  message!: string;

  @Field(() => ConsentType)
  consentType!: ConsentType;
}

/**
 * Consent history response with pagination info
 */
@ObjectType()
export class ConsentHistoryResponse {
  @Field(() => [UserConsentRecord])
  records!: UserConsentRecord[];

  @Field()
  totalCount!: number;
}
