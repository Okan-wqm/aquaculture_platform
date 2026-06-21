import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { HydroponicsOutbox } from './hydroponics-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(HydroponicsOutbox)],
  exports: [OutboxModule],
})
export class HydroponicsOutboxModule {}
