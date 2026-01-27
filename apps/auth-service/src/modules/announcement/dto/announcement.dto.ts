import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsEnum, IsBoolean, IsDateString } from 'class-validator';

import {
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementScope,
} from '../entities/announcement.entity';

/**
 * Input for announcement target criteria
 * NOTE: This class must be defined BEFORE classes that reference it
 * to avoid "Cannot access before initialization" errors in webpack bundles
 */
@InputType()
export class AnnouncementTargetInput {
  @Field(() => [String], { nullable: true })
  tenantIds?: string[];

  @Field(() => [String], { nullable: true })
  excludeTenantIds?: string[];

  @Field(() => [String], { nullable: true })
  plans?: string[];

  @Field(() => [String], { nullable: true })
  modules?: string[];

  @Field(() => [String], { nullable: true })
  regions?: string[];
}

/**
 * Input for creating a platform-wide announcement (SuperAdmin)
 */
@InputType()
export class CreatePlatformAnnouncementInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  title!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  content!: string;

  @Field(() => AnnouncementType, { defaultValue: AnnouncementType.INFO })
  @IsEnum(AnnouncementType)
  type!: AnnouncementType;

  @Field({ defaultValue: true })
  @IsBoolean()
  isGlobal!: boolean;

  @Field(() => AnnouncementTargetInput, { nullable: true })
  @IsOptional()
  targetCriteria?: AnnouncementTargetInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  publishAt?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  requiresAcknowledgment!: boolean;
}

/**
 * Input for creating a tenant-level announcement (TenantAdmin)
 */
@InputType()
export class CreateTenantAnnouncementInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  title!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  content!: string;

  @Field(() => AnnouncementType, { defaultValue: AnnouncementType.INFO })
  @IsEnum(AnnouncementType)
  type!: AnnouncementType;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  publishAt?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @Field({ defaultValue: false })
  @IsBoolean()
  requiresAcknowledgment!: boolean;
}

/**
 * Announcement list item for display
 */
@ObjectType()
export class AnnouncementListItem {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  content!: string;

  @Field(() => AnnouncementType)
  type!: AnnouncementType;

  @Field(() => AnnouncementStatus)
  status!: AnnouncementStatus;

  @Field(() => AnnouncementScope)
  scope!: AnnouncementScope;

  @Field()
  isGlobal!: boolean;

  @Field(() => Date, { nullable: true })
  publishAt!: Date | null;

  @Field(() => Date, { nullable: true })
  expiresAt!: Date | null;

  @Field()
  requiresAcknowledgment!: boolean;

  @Field()
  viewCount!: number;

  @Field()
  acknowledgmentCount!: number;

  @Field()
  createdByName!: string;

  @Field()
  createdAt!: Date;

  @Field()
  isActive!: boolean;

  // For tenant admin - acknowledgment status
  @Field({ nullable: true })
  hasViewed?: boolean;

  @Field({ nullable: true })
  hasAcknowledged?: boolean;
}

/**
 * Announcement statistics
 */
@ObjectType()
export class AnnouncementStats {
  @Field()
  total!: number;

  @Field()
  published!: number;

  @Field()
  scheduled!: number;

  @Field()
  draft!: number;

  @Field()
  expired!: number;

  @Field()
  totalViews!: number;

  @Field()
  totalAcknowledgments!: number;
}
