import { InputType, Field } from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Input for editing an existing message's content.
 */
@InputType()
export class EditMessageInput {
  @Field(() => String, { description: 'New message content (max 4000 chars)' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content: string;
}
