import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { SensorOutbox } from './sensor-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(SensorOutbox)],
  exports: [OutboxModule],
})
export class SensorOutboxModule {}
