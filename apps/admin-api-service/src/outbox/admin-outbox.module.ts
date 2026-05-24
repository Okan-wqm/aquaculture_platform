import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { AdminOutbox } from './admin-outbox.entity';

@Global()
@Module({
  imports: [OutboxModule.forFeature(AdminOutbox)],
  exports: [OutboxModule],
})
export class AdminOutboxModule {
  readonly moduleName = 'AdminOutboxModule';
}
