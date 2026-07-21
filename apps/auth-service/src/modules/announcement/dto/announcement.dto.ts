import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsEnum, IsBoolean, IsDateString, MaxLength, IsUUID, IsArray, ArrayMaxSize } from 'class-validator';
import { Transform } from 'class-transformer';

import { escapeHtml } from '../../../utils/sanitize';

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
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: 'Maximum 100 tenant IDs allowed' })
  @IsUUID('4', { each: true, message: 'Each tenantId must be a valid UUID' })
  tenantIds?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100, { message: 'Maximum 100 excluded tenant IDs allowed' })
  @IsUUID('4', { each: true, message: 'Each excludeTenantId must be a valid UUID' })
  excludeTenantIds?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: 'Maximum 20 plans allowed' })
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  plans?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, { message: 'Maximum 50 modules allowed' })
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  modules?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, { message: 'Maximum 50 regions allowed' })
  @IsString({ each: true })
  @MaxLength(50, { each: true })
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
  @MaxLength(500, { message: 'Title must be at most 500 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  title!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50000, { message: 'Content must be at most 50000 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
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
  @MaxLength(500, { message: 'Title must be at most 500 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
  title!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50000, { message: 'Content must be at most 50000 characters' })
  @Transform(({ value }) => typeof value === 'string' ? escapeHtml(value.trim()) : value)
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
 * Input for updating an existing announcement (SuperAdmin, draft/scheduled only).
 *
 * APA-201: every field is optional — only supplied fields are applied. The
 * service rejects updates on published/expired/cancelled announcements.
 */
@InputType()
export class UpdateAnnouncementInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Title must be at most 500 characters' })
  @Transform(({ value }) => (typeof value === 'string' ? escapeHtml(value.trim()) : value))
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50000, { message: 'Content must be at most 50000 characters' })
  @Transform(({ value }) => (typeof value === 'string' ? escapeHtml(value.trim()) : value))
  content?: string;

  @Field(() => AnnouncementType, { nullable: true })
  @IsOptional()
  @IsEnum(AnnouncementType)
  type?: AnnouncementType;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;

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

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
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
