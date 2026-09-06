/**
 * Shared detector for NATS event handlers, used by every invariant that
 * reasons about the handler population (tenant context, tenancy scope,
 * delivery outcome). One detector, so the specs cannot disagree about what a
 * handler is.
 *
 * A NATS event handler implements `IEventHandler` (or carries an inline
 * `IEventHandler<...>` shape) AND registers on the NATS event bus. The bus
 * registration is what distinguishes it from an in-process `@OnEvent`
 * listener. Pass comment-stripped source.
 */
export function isNatsEventHandler(code: string): boolean {
  const isHandler =
    /\bimplements\s+[^{]*\bIEventHandler\b/.test(code) || /\bIEventHandler</.test(code);
  const subscribesOnBus = /\.subscribeWildcard\s*\(/.test(code) || /\.subscribe\s*\(/.test(code);
  return isHandler && subscribesOnBus;
}
