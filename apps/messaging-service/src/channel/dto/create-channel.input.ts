import { InputType, Field } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  MaxLength,
  IsArray,
  ArrayMinSize,
  IsUUID,
  IsEnum,
  ValidateIf,
  ArrayMaxSize,
} from 'class-validator';
import { ChannelType } from '../entities/channel.entity';

/**
 * Input for creating a new channel.
 *
 * - DIRECT: exactly 2 memberIds (creator + counterpart), name is ignored
 * - GROUP: at least 1 memberId (the creator is added automatically), name is required
 * - AI: at least 1 memberId, name is optional
 */
@InputType()
export class CreateChannelInput {
  @Field(() => ChannelType, { description: 'Channel type: DIRECT, GROUP, or AI' })
  @IsEnum(ChannelType)
  type!: ChannelType;

  @Field(() => String, { nullable: true, description: 'Channel name (required for GROUP)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true, description: 'Channel description' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => [String], { description: 'Member user IDs to add to the channel' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  memberIds!: string[];
}
