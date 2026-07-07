import { InputType, Field, ID } from '@nestjs/graphql';
import { IsUUID } from 'class-validator';
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

/**
 * Input for marking messages as read up to a specific message in a channel.
 *
 * Extends MobileCommandEnvelopeInput (MSG-HIGH-058) so the offline queue's
 * unconditionally-injected envelope fields (clientCommandId, payloadHash,
 * deviceId, ...) are part of the input schema — mirroring SendMessageInput
 * (MSG-CRITICAL-054). Without this the gateway ValidationPipe
 * (forbidNonWhitelisted:true) rejected an offline-replayed mark-read carrying the
 * envelope with a 400, so channel_members.lastReadAt never advanced for offline
 * reads and the unread badge stayed permanently stuck. The envelope fields are
 * all optional (additive, blue-green-safe); the mark-read handler is idempotent
 * by construction (monotonic lastReadAt cursor) and ignores them.
 */
@InputType()
export class MarkReadInput extends MobileCommandEnvelopeInput {
  @Field(() => ID, { description: 'Channel UUID' })
  @IsUUID()
  channelId: string;

  @Field(() => ID, { description: 'Last read message UUID' })
  @IsUUID()
  messageId: string;
}
