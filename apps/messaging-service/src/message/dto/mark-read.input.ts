import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID } from 'class-validator';

/**
 * Input for marking messages as read up to a specific message in a channel.
 */
@InputType()
export class MarkReadInput {
  @Field(() => ID, { description: 'Channel UUID' })
  @IsUUID()
  channelId: string;

  @Field(() => ID, { description: 'Last read message UUID' })
  @IsUUID()
  messageId: string;
}
