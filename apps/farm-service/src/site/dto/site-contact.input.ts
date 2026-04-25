/**
 * SiteContactInput — Scope A Phase 4.4.3.
 *
 * Used as a child of `UpsertSiteContactsInput`. Each item describes
 * one row to land on the site_contacts table after the upsert. The
 * parent input carries the siteId (so the child's row knows which
 * site it belongs to without repeating the FK on every entry).
 */
import { Field, InputType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

@InputType()
export class SiteContactInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;

  /**
   * RFC-5321 validation via `@IsEmail()`. Loose enough for office
   * addresses (`procurement+supplier@org.tr` etc) but rejects
   * obvious typos. Empty string is rejected — pass `undefined`/null
   * to mean "no email".
   */
  @Field({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;

  /**
   * Phone is intentionally NOT validated as E.164 — operators
   * record local numbers, extension-suffixed direct lines, and
   * occasionally formats like "+90 532 555 1234". The 50-char cap
   * mirrors the column constraint.
   */
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
