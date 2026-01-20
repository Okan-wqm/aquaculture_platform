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
  return Reflect.getMetadata(EVENT_HANDLER_METADATA, target.constructor);
}

/**
 * Get subscription metadata from a method
 */
export function getSubscriptionMetadata(
  target: object,
  propertyKey: string | symbol,
): SubscribeToOptions | undefined {
  return Reflect.getMetadata(EVENT_SUBSCRIPTION_METADATA, target, propertyKey);
}
