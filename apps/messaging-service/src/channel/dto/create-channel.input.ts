/**
 * @module CreateChannelInput
 * @description GraphQL input for creating a new channel. Supports AI persona
 * selection and custom MCP server URL override for AI channels.
 * @see ADR-012 section 3 (Channel domain) & Phase 4 AI Persona system
 */
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
  Matches,
} from 'class-validator';
import { ChannelType } from '../entities/channel.entity';

/**
 * Input for creating a new channel.
 *
 * - DIRECT: exactly 2 memberIds (creator + counterpart), name is ignored
 * - GROUP: at least 1 memberId (the creator is added automatically), name is required
 * - AI: at least 1 memberId, name is optional. Supports aiPersona.
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
  @ValidateIf((o: CreateChannelInput) => o.type !== ChannelType.AI)
  @ArrayMinSize(1, { message: 'At least 1 member is required for DIRECT/GROUP channels' })
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  memberIds!: string[];

  @Field(() => String, {
    nullable: true,
    description: 'AI persona ID (e.g. "expert-v1", "operator-v1"). Only for AI channels.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9-]*-v\d+$/, {
    message: 'aiPersona must be a valid persona identifier (e.g. "expert-v1")',
  })
  aiPersona?: string;

  // MSG-HIGH-060: `aiServiceUrl` removed — see channel.entity.ts. A member could
  // set it to any public HTTPS endpoint and the bridge exfiltrated conversation
  // context + tenantId there. BYOK routes all AI through ai-service over NATS.
}
