import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { AlertOutbox } from './alert-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(AlertOutbox)],
  exports: [OutboxModule],
})
export class AlertOutboxModule {}
