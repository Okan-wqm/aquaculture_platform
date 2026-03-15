import { ObjectType, Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Default notification preferences applied when a user has no stored preferences.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesData = {
  emailEnabled: true,
  smsEnabled: false,
  pushEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: 'Europe/Istanbul',
  alertNotifications: true,
  taskNotifications: true,
  systemNotifications: true,
};

/**
 * Raw shape stored in JSONB column
 */
export interface NotificationPreferencesData {
  emailEnabled: boolean;
  smsEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string;
  alertNotifications: boolean;
  taskNotifications: boolean;
  systemNotifications: boolean;
}

/**
 * GraphQL output type for notification preferences
 */
@ObjectType()
export class NotificationPreferences {
  @Field()
  emailEnabled!: boolean;

  @Field()
  smsEnabled!: boolean;

  @Field()
  pushEnabled!: boolean;

  @Field(() => String, { nullable: true, description: 'HH:mm format, e.g. "22:00"' })
  quietHoursStart!: string | null;

  @Field(() => String, { nullable: true, description: 'HH:mm format, e.g. "07:00"' })
  quietHoursEnd!: string | null;

  @Field({ description: 'IANA timezone, e.g. "Europe/Istanbul"' })
  quietHoursTimezone!: string;

  @Field()
  alertNotifications!: boolean;

  @Field()
  taskNotifications!: boolean;

  @Field()
  systemNotifications!: boolean;
}

/**
 * GraphQL input type for updating notification preferences.
 * All fields are optional — only provided fields are updated.
 */
@InputType()
export class UpdateNotificationPreferencesInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @Field(() => String, { nullable: true, description: 'HH:mm format, e.g. "22:00". Set to null to disable quiet hours.' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'quietHoursStart must be in HH:mm format' })
  quietHoursStart?: string | null;

  @Field(() => String, { nullable: true, description: 'HH:mm format, e.g. "07:00". Set to null to disable quiet hours.' })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'quietHoursEnd must be in HH:mm format' })
  quietHoursEnd?: string | null;

  @Field(() => String, { nullable: true, description: 'IANA timezone, e.g. "Europe/Istanbul"' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  quietHoursTimezone?: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  alertNotifications?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  taskNotifications?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  systemNotifications?: boolean;
}
