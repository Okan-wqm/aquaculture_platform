/**
 * DeadLetterModule (W7, FARM-MEDIUM-260)
 *
 * Registers the service's dead-letter shelf. `@Global()` is load-bearing, not
 * convenience: `NatsEventBus` is constructed inside `EventBusModule`'s own
 * injector, so a locally-scoped provider would never reach it and the bus
 * would silently fall back to "no shelf" — the exact failure this wave closes.
 *
 * Registering the module is the ONLY wiring a service needs; the bus picks the
 * sink up optionally, so a service that has not (yet) created its `event_dlq`
 * table keeps its current NAK-until-exhausted behaviour instead of failing to
 * boot.
 */
import { DynamicModule, Global, Module, Provider } from '@nestjs/common';

import {
  DEAD_LETTER_SINK,
  DEAD_LETTER_SINK_OPTIONS,
  type DeadLetterSinkOptions,
} from './dead-letter.contract';
import { TypeormDeadLetterSink } from './typeorm-dead-letter.sink';

@Global()
@Module({})
export class DeadLetterModule {
  static forRoot(options: DeadLetterSinkOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: DEAD_LETTER_SINK_OPTIONS, useValue: options },
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
