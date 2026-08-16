import { DynamicModule, Global, Module, Provider } from '@nestjs/common';

import {
  DEAD_LETTER_SINK,
  DEAD_LETTER_SINK_OPTIONS,
  type DeadLetterSinkOptions,
} from './dead-letter.contract';
import { TypeormDeadLetterSink } from './typeorm-dead-letter.sink';

/**
 * Global because NatsEventBus is created inside EventBusModule's injector.
 * A locally scoped sink would be invisible at precisely the transport boundary
 * that must confirm the durable write.
 */
@Global()
@Module({})
export class DeadLetterModule {
  static forRoot(options: DeadLetterSinkOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: DEAD_LETTER_SINK_OPTIONS, useValue: Object.freeze({ ...options }) },
      TypeormDeadLetterSink,
      { provide: DEAD_LETTER_SINK, useExisting: TypeormDeadLetterSink },
    ];

    return {
      module: DeadLetterModule,
      providers,
      exports: [DEAD_LETTER_SINK, TypeormDeadLetterSink],
    };
  }
}
