import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { AiOutbox } from './ai-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(AiOutbox)],
  exports: [OutboxModule],
})
export class AiOutboxModule {}
