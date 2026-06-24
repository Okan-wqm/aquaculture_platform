import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { NotificationOutbox } from './notification-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(NotificationOutbox)],
  exports: [OutboxModule],
})
export class NotificationOutboxModule {}
