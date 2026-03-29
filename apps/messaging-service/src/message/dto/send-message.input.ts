import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsString,
  MaxLength,
  IsEnum,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { MessageContentType } from '../entities/message.entity';
import GraphQLJSON from 'graphql-type-json';

/**
 * Input for sending a new message.
 * idempotencyKey is required to prevent duplicate sends on retry.
 */
@InputType()
export class SendMessageInput {
  @Field(() => ID, { description: 'Target channel UUID' })
  @IsUUID()
  channelId: string;

  @Field(() => String, {
    nullable: true,
    description: 'Message text content (max 4000 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content: string | null;

  @Field(() => MessageContentType, {
    defaultValue: MessageContentType.TEXT,
    description: 'Content type of the message',
  })
  @IsEnum(MessageContentType)
  contentType: MessageContentType;

  @Field(() => ID, {
    nullable: true,
    description: 'Parent message ID for threading / replies',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @Field(() => [String], {
    nullable: true,
    description: 'Storage keys for pre-uploaded attachments',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  attachmentKeys?: string[];

  @Field(() => ID, {
    description: 'Client-generated UUID for idempotent send',
  })
  @IsUUID()
  idempotencyKey: string;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: 'Arbitrary metadata JSON',
  })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
