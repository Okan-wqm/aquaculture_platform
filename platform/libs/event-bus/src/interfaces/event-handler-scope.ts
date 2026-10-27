import type { IEvent } from './event-bus.interface';

/**
 * The execution scope the bus runs an event's work in (PLAT-HIGH-936).
 *
 * A NATS handler runs with no HTTP request behind it, so nothing binds the
 * event's tenant to the database session: a write to a row-level-security
 * table is refused and a read sees nothing. Each handler used to be left to
 * wrap itself, and a handler that forgot failed only at runtime, on a real
 * event, as a redelivery loop.
 *
 * The bus is the one place every handler (and the dead-letter record of its
 * event) passes through, so a service binds its scope ONCE through
 * `EVENT_HANDLER_SCOPE` and the bus runs all of that work inside it. The scope
 * is a port, not an implementation: the platform library knows nothing about
 * tenants' storage, a tenant-scoped service supplies the scope that binds its
 * own session context.
 */
export interface IEventHandlerScope {
  /** Runs `work` (a handler invocation or a dead-letter write) for `event`. */
  run<T>(event: IEvent, work: () => Promise<T>): Promise<T>;
}

export const EVENT_HANDLER_SCOPE = 'EVENT_HANDLER_SCOPE';

/** Default scope: the work runs as it is. Services without tenant-bound storage keep it. */
export class PassThroughEventHandlerScope implements IEventHandlerScope {
  run<T>(_event: IEvent, work: () => Promise<T>): Promise<T> {
    return work();
  }
}
