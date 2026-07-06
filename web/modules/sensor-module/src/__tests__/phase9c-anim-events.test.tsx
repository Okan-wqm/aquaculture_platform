/**
 * Phase 9C: Animation and Event enhancements test suite.
 *
 * Tests cover:
 * 1. Opacity animation — linear interpolation from tag range to opacity range
 * 2. VideoPlayback animation — tag-driven play/pause/stop commands
 * 3. TextFormat animation — printf-style formatted tag value display
 * 4. setProperty event action — widget config property updates
 * 5. closeDialog event action — overlay stack pop
 * 6. AnimationsPanel UI — new animation type options
 * 7. EventsPanel UI — new event action options
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { evaluate, safeSprintf } from '../engine/animation/AnimationEngine';
import type { AnimationRule } from '../engine/animation/types';
import { createSetPropertyHandler, _isPropertyPathSafe } from '../engine/events/handlers/SetPropertyHandler';
import { createCloseDialogHandler } from '../engine/events/handlers/CloseDialogHandler';
import type { WidgetEventPayload } from '../engine/events/types';

/* ================================================================== */
/*  1. Opacity Animation                                               */
/* ================================================================== */

describe('Opacity animation rule', () => {
  it('maps tag 50 in [0,100] to opacity 0.75 in [0.5, 1.0]', () => {
    const rules: AnimationRule[] = [
      {
        id: 'op-1',
        tagName: 'signal',
        range: { min: 0, max: 100 },
        type: 'opacity',
        options: { minOpacity: 0.5, maxOpacity: 1.0 },
      },
    ];
    const state = evaluate(rules, { signal: 50 });
    expect(state.mappedOpacity).toBeCloseTo(0.75, 5);
  });

  it('clamps at lower boundary (tag = range.min)', () => {
    const rules: AnimationRule[] = [
      {
        id: 'op-2',
        tagName: 'signal',
        range: { min: 10, max: 90 },
        type: 'opacity',
        options: { minOpacity: 0.2, maxOpacity: 0.8 },
      },
    ];
    const state = evaluate(rules, { signal: 10 });
    expect(state.mappedOpacity).toBeCloseTo(0.2, 5);
  });

  it('clamps at upper boundary (tag = range.max)', () => {
    const rules: AnimationRule[] = [
      {
        id: 'op-3',
        tagName: 'signal',
        range: { min: 10, max: 90 },
        type: 'opacity',
        options: { minOpacity: 0.2, maxOpacity: 0.8 },
      },
    ];
    const state = evaluate(rules, { signal: 90 });
    expect(state.mappedOpacity).toBeCloseTo(0.8, 5);
  });

  it('defaults to [0, 1] when minOpacity/maxOpacity not provided', () => {
    const rules: AnimationRule[] = [
      {
        id: 'op-4',
        tagName: 'signal',
        range: { min: 0, max: 100 },
        type: 'opacity',
        options: {},
      },
    ];
    const state = evaluate(rules, { signal: 50 });
    expect(state.mappedOpacity).toBeCloseTo(0.5, 5);
  });

  it('does not set mappedOpacity when tag is out of range', () => {
    const rules: AnimationRule[] = [
      {
        id: 'op-5',
        tagName: 'signal',
        range: { min: 20, max: 80 },
        type: 'opacity',
        options: { minOpacity: 0.3, maxOpacity: 0.9 },
      },
    ];
    const state = evaluate(rules, { signal: 10 });
    expect(state.mappedOpacity).toBeUndefined();
  });
});

/* ================================================================== */
/*  2. VideoPlayback Animation                                         */
/* ================================================================== */

describe('VideoPlayback animation rule', () => {
  it('sets videoCommand when tag is in range', () => {
    const rules: AnimationRule[] = [
      {
        id: 'vp-1',
        tagName: 'camStatus',
        range: { min: 1, max: 1 },
        type: 'videoPlayback',
        options: { videoAction: 'play' },
      },
    ];
    const state = evaluate(rules, { camStatus: 1 });
    expect(state.videoCommand).toBe('play');
  });

  it('sets pause command', () => {
    const rules: AnimationRule[] = [
      {
        id: 'vp-2',
        tagName: 'camStatus',
        range: { min: 2, max: 2 },
        type: 'videoPlayback',
        options: { videoAction: 'pause' },
      },
    ];
    const state = evaluate(rules, { camStatus: 2 });
    expect(state.videoCommand).toBe('pause');
  });

  it('sets stop command', () => {
    const rules: AnimationRule[] = [
      {
        id: 'vp-3',
        tagName: 'camStatus',
        range: { min: 0, max: 0 },
        type: 'videoPlayback',
        options: { videoAction: 'stop' },
      },
    ];
    const state = evaluate(rules, { camStatus: 0 });
    expect(state.videoCommand).toBe('stop');
  });

  it('defaults to play when videoAction not specified', () => {
    const rules: AnimationRule[] = [
      {
        id: 'vp-4',
        tagName: 'camStatus',
        range: { min: 1, max: 1 },
        type: 'videoPlayback',
        options: {},
      },
    ];
    const state = evaluate(rules, { camStatus: 1 });
    expect(state.videoCommand).toBe('play');
  });

  it('does not set videoCommand when tag is out of range', () => {
    const rules: AnimationRule[] = [
      {
        id: 'vp-5',
        tagName: 'camStatus',
        range: { min: 1, max: 1 },
        type: 'videoPlayback',
        options: { videoAction: 'play' },
      },
    ];
    const state = evaluate(rules, { camStatus: 0 });
    expect(state.videoCommand).toBeUndefined();
  });
});

/* ================================================================== */
/*  3. TextFormat Animation (safeSprintf)                              */
/* ================================================================== */

describe('TextFormat animation rule', () => {
  it('formats %.2f with value 3.14159 to "3.14"', () => {
    const rules: AnimationRule[] = [
      {
        id: 'tf-1',
        tagName: 'temp',
        range: { min: 0, max: 100 },
        type: 'textFormat',
        options: { textFormat: '%.2f' },
      },
    ];
    const state = evaluate(rules, { temp: 3.14159 });
    expect(state.formattedText).toBe('3.14');
  });

  it('formats %d%% with value 75 to "75%"', () => {
    const rules: AnimationRule[] = [
      {
        id: 'tf-2',
        tagName: 'level',
        range: { min: 0, max: 100 },
        type: 'textFormat',
        options: { textFormat: '%d%%' },
      },
    ];
    const state = evaluate(rules, { level: 75 });
    expect(state.formattedText).toBe('75%');
  });

  it('formats "Temp: %.1f°C" with value 23.5 to "Temp: 23.5°C"', () => {
    const rules: AnimationRule[] = [
      {
        id: 'tf-3',
        tagName: 'temp',
        range: { min: 0, max: 100 },
        type: 'textFormat',
        options: { textFormat: 'Temp: %.1f°C' },
      },
    ];
    const state = evaluate(rules, { temp: 23.5 });
    expect(state.formattedText).toBe('Temp: 23.5°C');
  });

  it('does not set formattedText when tag is out of range', () => {
    const rules: AnimationRule[] = [
      {
        id: 'tf-4',
        tagName: 'temp',
        range: { min: 10, max: 50 },
        type: 'textFormat',
        options: { textFormat: '%.2f' },
      },
    ];
    const state = evaluate(rules, { temp: 5 });
    expect(state.formattedText).toBeUndefined();
  });
});

describe('safeSprintf', () => {
  it('handles %d with integer value', () => {
    expect(safeSprintf('%d', 42)).toBe('42');
  });

  it('handles %d with float value (rounds)', () => {
    expect(safeSprintf('%d', 42.7)).toBe('43');
  });

  it('handles %f default precision (6 decimals)', () => {
    expect(safeSprintf('%f', 3.14)).toBe('3.140000');
  });

  it('handles %.0f', () => {
    expect(safeSprintf('%.0f', 3.7)).toBe('4');
  });

  it('handles %s with numeric value', () => {
    expect(safeSprintf('%s', 42)).toBe('42');
  });

  it('handles %% literal percent', () => {
    expect(safeSprintf('100%%', 0)).toBe('100%');
  });

  it('handles mixed text and format specifiers', () => {
    expect(safeSprintf('Value: %.1f units', 7.89)).toBe('Value: 7.9 units');
  });

  it('handles trailing percent sign', () => {
    expect(safeSprintf('test%', 0)).toBe('test%');
  });

  it('handles unrecognized specifier gracefully', () => {
    expect(safeSprintf('%x', 255)).toBe('%x');
  });

  it('handles empty format string', () => {
    expect(safeSprintf('', 42)).toBe('');
  });
});

/* ================================================================== */
/*  4. setProperty Event Handler                                       */
/* ================================================================== */

describe('SetPropertyHandler', () => {
  it('calls updateWidget with the correct config update', () => {
    const updateWidget = vi.fn();
    const handler = createSetPropertyHandler({ updateWidget });

    const event: WidgetEventPayload = {
      widgetId: 'src-widget',
      screenId: 'screen-1',
      action: 'setProperty',
      params: {
        targetWidgetId: 'target-widget',
        propertyPath: 'fill',
        propertyValue: '#ff0000',
      },
    };

    handler(event);

    expect(updateWidget).toHaveBeenCalledWith('screen-1', 'target-widget', {
      config: { fill: '#ff0000' },
    });
  });

  it('handles nested property paths', () => {
    const updateWidget = vi.fn();
    const handler = createSetPropertyHandler({ updateWidget });

    const event: WidgetEventPayload = {
      widgetId: 'src',
      screenId: 'screen-1',
      action: 'setProperty',
      params: {
        targetWidgetId: 'target',
        propertyPath: 'style.borderColor',
        propertyValue: '#00ff00',
      },
    };

    handler(event);

    expect(updateWidget).toHaveBeenCalledWith('screen-1', 'target', {
      config: { style: { borderColor: '#00ff00' } },
    });
  });

  it('does nothing when targetWidgetId is missing', () => {
    const updateWidget = vi.fn();
    const handler = createSetPropertyHandler({ updateWidget });

    const event: WidgetEventPayload = {
      widgetId: 'src',
      screenId: 'screen-1',
      action: 'setProperty',
      params: {
        propertyPath: 'fill',
        propertyValue: '#ff0000',
      },
    };

    handler(event);
    expect(updateWidget).not.toHaveBeenCalled();
  });

  it('does nothing when propertyPath is missing', () => {
    const updateWidget = vi.fn();
    const handler = createSetPropertyHandler({ updateWidget });

    const event: WidgetEventPayload = {
      widgetId: 'src',
      screenId: 'screen-1',
      action: 'setProperty',
      params: {
        targetWidgetId: 'target',
        propertyValue: '#ff0000',
      },
    };

    handler(event);
    expect(updateWidget).not.toHaveBeenCalled();
  });
});

describe('isPropertyPathSafe', () => {
  it('accepts simple paths', () => {
    expect(_isPropertyPathSafe('fill')).toBe(true);
    expect(_isPropertyPathSafe('config.opacity')).toBe(true);
    expect(_isPropertyPathSafe('style.borderColor')).toBe(true);
  });

  it('rejects __proto__', () => {
    expect(_isPropertyPathSafe('__proto__')).toBe(false);
    expect(_isPropertyPathSafe('a.__proto__.b')).toBe(false);
  });

  it('rejects constructor', () => {
    expect(_isPropertyPathSafe('constructor')).toBe(false);
    expect(_isPropertyPathSafe('a.constructor.prototype')).toBe(false);
  });

  it('rejects prototype', () => {
    expect(_isPropertyPathSafe('prototype')).toBe(false);
  });

  it('rejects empty path', () => {
    expect(_isPropertyPathSafe('')).toBe(false);
  });

  it('rejects paths with consecutive dots', () => {
    expect(_isPropertyPathSafe('a..b')).toBe(false);
  });

  it('rejects paths with special characters', () => {
    expect(_isPropertyPathSafe('a[0]')).toBe(false);
    expect(_isPropertyPathSafe('a/b')).toBe(false);
  });
});

/* ================================================================== */
/*  5. closeDialog Event Handler                                       */
/* ================================================================== */

describe('CloseDialogHandler', () => {
  it('closes the topmost overlay', () => {
    const closeOverlay = vi.fn();
    const overlays = [
      { id: 'overlay-1' },
      { id: 'overlay-2' },
    ];

    const handler = createCloseDialogHandler(() => ({
      overlays,
      closeOverlay,
    }));

    const event: WidgetEventPayload = {
      widgetId: 'close-btn',
      screenId: 'screen-1',
      action: 'closeDialog',
      params: {},
    };

    handler(event);

    // Should close the last (topmost) overlay
    expect(closeOverlay).toHaveBeenCalledWith('overlay-2');
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no overlays are open', () => {
    const closeOverlay = vi.fn();

    const handler = createCloseDialogHandler(() => ({
      overlays: [],
      closeOverlay,
    }));

    const event: WidgetEventPayload = {
      widgetId: 'close-btn',
      screenId: 'screen-1',
      action: 'closeDialog',
      params: {},
    };

    handler(event);
    expect(closeOverlay).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  6. AnimationsPanel UI — new animation type options                  */
/* ================================================================== */

describe('AnimationsPanel renders new animation types', () => {
  // We test the ANIMATION_TYPE_OPTIONS array presence by rendering the
  // panel and checking the dropdown options. However the panel requires
  // several dependencies (TagBrowser, store). For isolation, we verify
  // the exported constants by importing and checking the options.
  //
  // NOTE: A full render test requires module mocks for TagBrowser/store;
  // until those exist, the dropdown options are validated through the
  // animation engine integration above.

  it('opacity type is recognized by the animation engine', () => {
    const rules: AnimationRule[] = [
      {
        id: 'test',
        tagName: 't',
        range: { min: 0, max: 1 },
        type: 'opacity',
        options: { minOpacity: 0, maxOpacity: 1 },
      },
    ];
    const state = evaluate(rules, { t: 0.5 });
    expect(state.mappedOpacity).toBeDefined();
  });

  it('videoPlayback type is recognized by the animation engine', () => {
    const rules: AnimationRule[] = [
      {
        id: 'test',
        tagName: 't',
        range: { min: 0, max: 1 },
        type: 'videoPlayback',
        options: { videoAction: 'pause' },
      },
    ];
    const state = evaluate(rules, { t: 0.5 });
    expect(state.videoCommand).toBe('pause');
  });

  it('textFormat type is recognized by the animation engine', () => {
    const rules: AnimationRule[] = [
      {
        id: 'test',
        tagName: 't',
        range: { min: 0, max: 100 },
        type: 'textFormat',
        options: { textFormat: '%d units' },
      },
    ];
    const state = evaluate(rules, { t: 42 });
    expect(state.formattedText).toBe('42 units');
  });
});

/* ================================================================== */
/*  7. EventsPanel UI — new event action options                       */
/* ================================================================== */

describe('EventsPanel new action types', () => {
  // Verify that the new action types work end-to-end at the handler level.
  // Full UI render tests would require mocking useScadaPackageStore and TagBrowser.

  it('setProperty action type exists in EventAction union', () => {
    // TypeScript compilation validates the union, but we also verify
    // the handler factory accepts it without errors
    const handler = createSetPropertyHandler({ updateWidget: vi.fn() });
    expect(typeof handler).toBe('function');
  });

  it('closeDialog action type exists in EventAction union', () => {
    const handler = createCloseDialogHandler(() => ({
      overlays: [],
      closeOverlay: vi.fn(),
    }));
    expect(typeof handler).toBe('function');
  });
});
