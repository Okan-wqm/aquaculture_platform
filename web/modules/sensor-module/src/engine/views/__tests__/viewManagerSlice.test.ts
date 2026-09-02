import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../../../store/scada/createScadaStore';

type Store = ReturnType<typeof createScadaStore>;

describe('ViewManagerSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = createScadaStore();
  });

  it('should start with an empty overlays array', () => {
    expect(store.getState().overlays).toEqual([]);
  });

  it('should open a card overlay and verify it is in the store', () => {
    const id = store.getState().openOverlay({
      type: 'card',
      screenId: 'screen-1',
      position: { x: 100, y: 200 },
    });

    const overlays = store.getState().overlays;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].id).toBe(id);
    expect(overlays[0].type).toBe('card');
    expect(overlays[0].screenId).toBe('screen-1');
    expect(overlays[0].position).toEqual({ x: 100, y: 200 });
  });

  it('should open a dialog overlay', () => {
    const id = store.getState().openOverlay({
      type: 'dialog',
      screenId: 'screen-2',
      position: { x: 0, y: 0 },
      size: { width: 800, height: 600 },
    });

    const overlays = store.getState().overlays;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].id).toBe(id);
    expect(overlays[0].type).toBe('dialog');
    expect(overlays[0].screenId).toBe('screen-2');
    expect(overlays[0].size).toEqual({ width: 800, height: 600 });
  });

  it('should close a specific overlay by id', () => {
    const id1 = store.getState().openOverlay({
      type: 'card',
      screenId: 'screen-1',
      position: { x: 0, y: 0 },
    });
    const id2 = store.getState().openOverlay({
      type: 'dialog',
      screenId: 'screen-2',
      position: { x: 0, y: 0 },
    });

    expect(store.getState().overlays).toHaveLength(2);

    store.getState().closeOverlay(id1);

    const overlays = store.getState().overlays;
    expect(overlays).toHaveLength(1);
    expect(overlays[0].id).toBe(id2);
  });

  it('should close all overlays with closeAllOverlays', () => {
    store.getState().openOverlay({ type: 'card', screenId: 'screen-1', position: { x: 0, y: 0 } });
    store
      .getState()
      .openOverlay({ type: 'dialog', screenId: 'screen-2', position: { x: 0, y: 0 } });
    store.getState().openOverlay({ type: 'card', screenId: 'screen-3', position: { x: 0, y: 0 } });

    expect(store.getState().overlays).toHaveLength(3);

    store.getState().closeAllOverlays();

    expect(store.getState().overlays).toEqual([]);
  });

  it('should return a unique id for each openOverlay call', () => {
    const id1 = store.getState().openOverlay({
      type: 'card',
      screenId: 'screen-1',
      position: { x: 0, y: 0 },
    });
    const id2 = store.getState().openOverlay({
      type: 'card',
      screenId: 'screen-1',
      position: { x: 0, y: 0 },
    });
    const id3 = store.getState().openOverlay({
      type: 'dialog',
      screenId: 'screen-2',
      position: { x: 0, y: 0 },
    });

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  it('should preserve variableMap when opening an overlay', () => {
    const varMap = { temp: 'tag:temperature', ph: 'tag:ph_sensor' };
    store.getState().openOverlay({
      type: 'dialog',
      screenId: 'screen-1',
      position: { x: 0, y: 0 },
      variableMap: varMap,
    });

    expect(store.getState().overlays[0].variableMap).toEqual(varMap);
  });
});
