/**
 * Mock EventBus factory for CQRS handler tests.
 *
 * Creates a mock that records all published events for assertions.
 * Supports both NestJS EventBus and platform NatsEventBus patterns.
 */

export interface MockEventBus {
  publish: jest.Mock;
  publishAll: jest.Mock;
  /** Helper: returns all events published via publish() */
  getPublishedEvents: () => unknown[];
  /** Helper: returns events matching a specific eventType */
  getEventsByType: (eventType: string) => unknown[];
  /** Reset all mocks and published events */
  reset: () => void;
}

export function createMockEventBus(): MockEventBus {
  const publishedEvents: unknown[] = [];

  const publish = jest.fn().mockImplementation((event: unknown) => {
    publishedEvents.push(event);
    return Promise.resolve();
  });

  const publishAll = jest.fn().mockImplementation((events: unknown[]) => {
    publishedEvents.push(...events);
    return Promise.resolve();
  });

  return {
    publish,
    publishAll,
    getPublishedEvents: () => [...publishedEvents],
    getEventsByType: (eventType: string) =>
      publishedEvents.filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'eventType' in event &&
          event.eventType === eventType,
      ),
    reset: () => {
      publish.mockClear();
      publishAll.mockClear();
      publishedEvents.length = 0;
    },
  };
}
