/**
 * Event delivery infrastructure shared by every consuming service.
 *
 * Deep-import barrel (`@aquaculture/backend-common/events`) — deliberately NOT
 * re-exported from the root barrel, so `@platform/event-bus` can depend on the
 * dead-letter contract without pulling backend-common's entire surface (and
 * its TypeORM entity side-effects) into the transport layer.
 */
export {
  DEAD_LETTER_SINK,
  DEAD_LETTER_SINK_OPTIONS,
} from './dead-letter.contract';
export type {
  DeadLetterEnvelope,
  DeadLetterSink,
  DeadLetterSinkOptions,
} from './dead-letter.contract';
export { DeadLetterModule } from './dead-letter.module';
export { TypeormDeadLetterSink } from './typeorm-dead-letter.sink';
