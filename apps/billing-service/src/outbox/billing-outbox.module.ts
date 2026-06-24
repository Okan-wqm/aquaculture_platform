import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { BillingOutbox } from './billing-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(BillingOutbox)],
  exports: [OutboxModule],
})
export class BillingOutboxModule {}
