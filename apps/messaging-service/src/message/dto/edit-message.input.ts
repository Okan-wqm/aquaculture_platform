import { InputType, Field } from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';

/**
 * Input for editing an existing message's content.
 *
 * Extends MobileCommandEnvelopeInput (MSG-HIGH-059) so the offline queue's
 * unconditionally-injected envelope fields (clientCommandId, payloadHash,
 * deviceId, ...) are part of the input schema — mirroring SendMessageInput
 * (MSG-CRITICAL-054). Without this the gateway ValidationPipe
 * (forbidNonWhitelisted:true) rejected an offline-replayed edit carrying the
 * envelope with a 400, so the edit was permanently lost behind a false "Queued"
 * badge after the retry budget drained. The envelope fields are all optional, so
 * this is an additive, blue-green-safe schema change; the edit handler is
 * idempotent by construction (own-message, last-write-wins) and ignores them.
 */
@InputType()
export class EditMessageInput extends MobileCommandEnvelopeInput {
  @Field(() => String, { description: 'New message content (max 4000 chars)' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}
