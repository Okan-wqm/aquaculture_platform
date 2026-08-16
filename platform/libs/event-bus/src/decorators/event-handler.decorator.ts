import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for event handler registration
 */
export const EVENT_HANDLER_METADATA = 'EVENT_HANDLER_METADATA';

/**
 * Metadata key for event subscription topic
 */
export const EVENT_SUBSCRIPTION_METADATA = 'EVENT_SUBSCRIPTION_METADATA';

/**
 * Event handler decorator options
 */
export interface EventHandlerOptions {
  eventName: string;
  groupId?: string;
  durable?: boolean;
  maxRetries?: number;
}

/**
 * Decorator to mark a class as an event handler
 * @param eventNameOrOptions - Event name string or options object
 */
export function EventHandler(
  eventNameOrOptions: string | EventHandlerOptions,
): ClassDecorator {
  const options: EventHandlerOptions =
    typeof eventNameOrOptions === 'string'
      ? { eventName: eventNameOrOptions }
      : eventNameOrOptions;

  return SetMetadata(EVENT_HANDLER_METADATA, options);
}

/**
 * Subscription options for SubscribeTo decorator
 */
export interface SubscribeToOptions {
  topic: string;
  groupId?: string;
  durable?: boolean;
  startFrom?: 'beginning' | 'latest';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isEventHandlerOptions(value: unknown): value is EventHandlerOptions {
  return (
    isRecord(value) &&
    typeof value['eventName'] === 'string' &&
    isOptionalString(value['groupId']) &&
    isOptionalBoolean(value['durable']) &&
    (value['maxRetries'] === undefined || typeof value['maxRetries'] === 'number')
  );
}

function isSubscribeToOptions(value: unknown): value is SubscribeToOptions {
  return (
    isRecord(value) &&
    typeof value['topic'] === 'string' &&
    isOptionalString(value['groupId']) &&
    isOptionalBoolean(value['durable']) &&
    (value['startFrom'] === undefined ||
      value['startFrom'] === 'beginning' ||
      value['startFrom'] === 'latest')
  );
}

/**
 * Decorator to subscribe a method to a specific topic
 * @param topicOrOptions - Topic string or subscription options
 */
export function SubscribeTo(
  topicOrOptions: string | SubscribeToOptions,
): MethodDecorator {
  const options: SubscribeToOptions =
    typeof topicOrOptions === 'string'
      ? { topic: topicOrOptions }
      : topicOrOptions;

  return SetMetadata(EVENT_SUBSCRIPTION_METADATA, options);
}

/**
 * Get event handler metadata from a class
 */
export function getEventHandlerMetadata(
  target: object,
): EventHandlerOptions | undefined {
  const metadata: unknown = Reflect.getMetadata(
    EVENT_HANDLER_METADATA,
    target.constructor,
  );
  return isEventHandlerOptions(metadata) ? metadata : undefined;
}

/**
 * Get subscription metadata from a method
 */
export function getSubscriptionMetadata(
  target: object,
  propertyKey: string | symbol,
): SubscribeToOptions | undefined {
  // Nest's SetMetadata method-decorator branch writes metadata on
  // `descriptor.value` (the method function), not on the instance/property
  // pair. Resolve the callable exactly as Nest stores it so the decorator and
  // registry share one metadata contract.
  const methodTarget: unknown = Reflect.get(target, propertyKey);
  if (typeof methodTarget !== 'function') {
    return undefined;
  }
  const metadata: unknown = Reflect.getMetadata(
    EVENT_SUBSCRIPTION_METADATA,
    methodTarget,
  );
  return isSubscribeToOptions(metadata) ? metadata : undefined;
}
