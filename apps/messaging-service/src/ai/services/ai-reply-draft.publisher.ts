import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';

import { aiReplyDraftSubject, type AiReplyDraftSignal } from '@platform/event-contracts';

/**
 * Publishes an AI reply's draft while ai-service writes it, for the gateway
 * bridge to relay to the channel room (MSG-MEDIUM-089). Core NATS and never
 * retried: a lost frame costs a moment of the typing effect, not the reply,
 * which is stored and delivered as a message either way.
 */
@Injectable()
export class AiReplyDraftPublisher {
  private readonly logger = new Logger(AiReplyDraftPublisher.name);

  constructor(
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  async publish(signal: AiReplyDraftSignal): Promise<void> {
    try {
      await lastValueFrom(this.natsClient.emit(aiReplyDraftSubject(signal.tenantId), signal), {
        defaultValue: undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI reply draft for ${signal.replyKey} was not published: ${msg}`);
    }
  }
}
