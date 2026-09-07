// Interfaces — every export from event-bus.interface is a `type`/
// `interface` (no runtime values), so isolatedModules treats them
// correctly via `export type * ...`. The aliased re-export needs
// the `type` modifier to drop the runtime emission too.
export type * from './interfaces/event-bus.interface';
export type { IEventBus as EventBus } from './interfaces/event-bus.interface';
// PLAT-HIGH-902: handler delivery outcome (value + type), the fold the bus
// applies, and the dead-letter sink contract.
export * from './interfaces/handler-outcome';
export * from './interfaces/dead-letter-sink';

// NATS Implementation
export * from './nats/nats-event-bus';
export * from './nats/nats.module';
export * from './nats/event-bus-config.factory';
export * from './nats/nats-request-reply';
export * from './subjects/tenant-event-subject';

// Decorators
export * from './decorators/event-handler.decorator';
