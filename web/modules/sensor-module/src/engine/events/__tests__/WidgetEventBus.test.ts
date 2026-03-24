import { WidgetEventBus } from '../WidgetEventBus';
import type { WidgetEventPayload, EventHandler } from '../types';

function makePayload(overrides: Partial<WidgetEventPayload> = {}): WidgetEventPayload {
  return {
    widgetId: 'w1',
    screenId: 's1',
    action: 'navigate',
    params: {},
    ...overrides,
  };
}

describe('WidgetEventBus', () => {
  let bus: WidgetEventBus;

  beforeEach(() => {
    bus = new WidgetEventBus();
  });

  it('dispatches to registered handler', () => {
    const handler: EventHandler = vi.fn();
    bus.register('navigate', handler);
    const event = makePayload({ action: 'navigate', params: { targetScreenId: 'screen2' } });
    bus.dispatch(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not dispatch to unrelated handler', () => {
    const navigateHandler: EventHandler = vi.fn();
    const setValueHandler: EventHandler = vi.fn();
    bus.register('navigate', navigateHandler);
    bus.register('setValue', setValueHandler);
    const event = makePayload({ action: 'navigate' });
    bus.dispatch(event);
    expect(navigateHandler).toHaveBeenCalledTimes(1);
    expect(setValueHandler).not.toHaveBeenCalled();
  });

  it('unregister stops delivery', () => {
    const handler: EventHandler = vi.fn();
    const unregister = bus.register('openCard', handler);
    bus.dispatch(makePayload({ action: 'openCard' }));
    unregister();
    bus.dispatch(makePayload({ action: 'openCard' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports multiple handlers for same action', () => {
    const handler1: EventHandler = vi.fn();
    const handler2: EventHandler = vi.fn();
    bus.register('openDialog', handler1);
    bus.register('openDialog', handler2);
    const event = makePayload({ action: 'openDialog' });
    bus.dispatch(event);
    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  it('clear removes all handlers', () => {
    const handler1: EventHandler = vi.fn();
    const handler2: EventHandler = vi.fn();
    bus.register('navigate', handler1);
    bus.register('setValue', handler2);
    bus.clear();
    bus.dispatch(makePayload({ action: 'navigate' }));
    bus.dispatch(makePayload({ action: 'setValue' }));
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});
