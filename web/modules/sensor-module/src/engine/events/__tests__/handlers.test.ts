import { createNavigateHandler } from '../handlers/NavigateHandler';
import { createOverlayHandler } from '../handlers/OverlayHandler';
import { createTagWriteHandler } from '../handlers/TagWriteHandler';
import type { WidgetEventPayload } from '../types';

function makePayload(overrides: Partial<WidgetEventPayload> = {}): WidgetEventPayload {
  return {
    widgetId: 'w1',
    screenId: 's1',
    action: 'navigate',
    params: {},
    ...overrides,
  };
}

describe('NavigateHandler', () => {
  it('calls setActiveScreen with targetScreenId', () => {
    const setActiveScreen = vi.fn();
    const handler = createNavigateHandler(setActiveScreen);
    handler(makePayload({
      action: 'navigate',
      params: { targetScreenId: 'screen-42' },
    }));
    expect(setActiveScreen).toHaveBeenCalledWith('screen-42');
  });

  it('does not call setActiveScreen when targetScreenId is missing', () => {
    const setActiveScreen = vi.fn();
    const handler = createNavigateHandler(setActiveScreen);
    handler(makePayload({ action: 'navigate', params: {} }));
    expect(setActiveScreen).not.toHaveBeenCalled();
  });
});

describe('OverlayHandler', () => {
  it('opens card overlay with mouse position', () => {
    const openOverlay = vi.fn();
    const handler = createOverlayHandler({ openOverlay });
    handler(makePayload({
      action: 'openCard',
      params: { targetScreenId: 'card-screen', width: 500, height: 400 },
      mousePosition: { x: 150, y: 250 },
    }));
    expect(openOverlay).toHaveBeenCalledWith({
      type: 'card',
      screenId: 'card-screen',
      position: { x: 150, y: 250 },
      size: { width: 500, height: 400 },
    });
  });

  it('opens card overlay with default position when mouse position is missing', () => {
    const openOverlay = vi.fn();
    const handler = createOverlayHandler({ openOverlay });
    handler(makePayload({
      action: 'openCard',
      params: { targetScreenId: 'card-screen' },
    }));
    expect(openOverlay).toHaveBeenCalledWith({
      type: 'card',
      screenId: 'card-screen',
      position: { x: 300, y: 200 },
      size: { width: 400, height: 300 },
    });
  });

  it('opens dialog overlay', () => {
    const openOverlay = vi.fn();
    const handler = createOverlayHandler({ openOverlay });
    handler(makePayload({
      action: 'openDialog',
      params: { targetScreenId: 'dialog-screen', width: 800, height: 600 },
    }));
    expect(openOverlay).toHaveBeenCalledWith({
      type: 'dialog',
      screenId: 'dialog-screen',
      position: { x: 300, y: 160 },
      size: { width: 800, height: 600 },
    });
  });

  it('does nothing when targetScreenId is missing', () => {
    const openOverlay = vi.fn();
    const handler = createOverlayHandler({ openOverlay });
    handler(makePayload({ action: 'openCard', params: {} }));
    expect(openOverlay).not.toHaveBeenCalled();
  });
});

describe('TagWriteHandler', () => {
  it('sets value on target tag', () => {
    const publish = vi.fn();
    const getLatest = vi.fn();
    const handler = createTagWriteHandler({ publish, getLatest });
    handler(makePayload({
      action: 'setValue',
      params: { targetTag: 'pump1.speed', value: 1200 },
    }));
    expect(publish).toHaveBeenCalledWith('pump1.speed', 1200);
  });

  it('toggles boolean value', () => {
    const publish = vi.fn();
    const getLatest = vi.fn().mockReturnValue(false);
    const handler = createTagWriteHandler({ publish, getLatest });
    handler(makePayload({
      action: 'toggleValue',
      params: { toggleTag: 'valve1.open' },
    }));
    expect(getLatest).toHaveBeenCalledWith('valve1.open');
    expect(publish).toHaveBeenCalledWith('valve1.open', true);
  });

  it('toggles truthy value to false', () => {
    const publish = vi.fn();
    const getLatest = vi.fn().mockReturnValue(true);
    const handler = createTagWriteHandler({ publish, getLatest });
    handler(makePayload({
      action: 'toggleValue',
      params: { toggleTag: 'valve1.open' },
    }));
    expect(publish).toHaveBeenCalledWith('valve1.open', false);
  });
});
