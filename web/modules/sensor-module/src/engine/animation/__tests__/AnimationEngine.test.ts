import { describe, it, expect } from 'vitest';
import { evaluate } from '../AnimationEngine';
import { DEFAULT_ANIMATION_STATE } from '../types';
import type { AnimationRule } from '../types';

function makeRule(overrides: Partial<AnimationRule> & Pick<AnimationRule, 'type'>): AnimationRule {
  return {
    id: 'test-rule',
    tagName: 'sensor1',
    range: { min: 0, max: 100 },
    options: {},
    ...overrides,
  };
}

describe('AnimationEngine.evaluate', () => {
  it('returns default state with no rules', () => {
    const state = evaluate([], {});
    expect(state).toEqual(DEFAULT_ANIMATION_STATE);
  });

  it('hides widget when hide rule matches', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'hide', range: { min: 1, max: 1 } }),
    ];
    const state = evaluate(rules, { sensor1: 1 });
    expect(state.visible).toBe(false);
  });

  it('shows widget when show rule matches', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'hide', range: { min: 0, max: 100 } }),
      makeRule({ id: 'show-rule', type: 'show', range: { min: 0, max: 100 } }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.visible).toBe(true);
  });

  it('activates rotation when rotate rule matches (speed + direction)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'rotate',
        options: { rotationSpeed: 3000, direction: 'ccw' },
      }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.rotating).toBe(true);
    expect(state.rotationSpeed).toBe(3000);
    expect(state.rotationDirection).toBe('ccw');
  });

  it('uses default rotation speed and direction when not specified', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'rotate', options: {} }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.rotating).toBe(true);
    expect(state.rotationSpeed).toBe(2000);
    expect(state.rotationDirection).toBe('cw');
  });

  it('resolves color from colorRange (3 ranges: green/yellow/red)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'colorRange',
        options: {
          ranges: [
            { min: 0, max: 30, fill: '#22c55e', stroke: '#16a34a' },
            { min: 31, max: 70, fill: '#eab308', stroke: '#ca8a04' },
            { min: 71, max: 100, fill: '#ef4444', stroke: '#dc2626' },
          ],
        },
      }),
    ];

    const green = evaluate(rules, { sensor1: 15 });
    expect(green.fill).toBe('#22c55e');
    expect(green.stroke).toBe('#16a34a');

    const yellow = evaluate(rules, { sensor1: 50 });
    expect(yellow.fill).toBe('#eab308');
    expect(yellow.stroke).toBe('#ca8a04');

    const red = evaluate(rules, { sensor1: 85 });
    expect(red.fill).toBe('#ef4444');
    expect(red.stroke).toBe('#dc2626');
  });

  it('calculates fillPercent from fillLevel (including clamp at 0 and 100)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'fillLevel',
        range: { min: -100, max: 1000 },
        options: { fillMin: 0, fillMax: 200, fillColor: '#3b82f6' },
      }),
    ];

    // Normal value: 100 out of 0-200 = 50%
    const mid = evaluate(rules, { sensor1: 100 });
    expect(mid.fillPercent).toBe(50);
    expect(mid.fillColor).toBe('#3b82f6');

    // Below min: clamped to 0%
    const low = evaluate(rules, { sensor1: -50 });
    expect(low.fillPercent).toBe(0);

    // Above max: clamped to 100%
    const high = evaluate(rules, { sensor1: 500 });
    expect(high.fillPercent).toBe(100);
  });

  it('applies fillLevel warning/critical threshold colors', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'fillLevel',
        range: { min: 0, max: 100 },
        options: {
          fillMin: 0,
          fillMax: 100,
          fillColor: '#3b82f6',
          fillWarningThreshold: 70,
          fillWarningColor: '#f59e0b',
          fillCriticalThreshold: 90,
          fillCriticalColor: '#dc2626',
        },
      }),
    ];

    // Normal (50%) - base color
    const normal = evaluate(rules, { sensor1: 50 });
    expect(normal.fillColor).toBe('#3b82f6');

    // Warning (75%) - warning color
    const warning = evaluate(rules, { sensor1: 75 });
    expect(warning.fillColor).toBe('#f59e0b');

    // Critical (95%) - critical color
    const critical = evaluate(rules, { sensor1: 95 });
    expect(critical.fillColor).toBe('#dc2626');
  });

  it('uses default warning/critical colors when custom colors not provided', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'fillLevel',
        range: { min: 0, max: 100 },
        options: {
          fillMin: 0,
          fillMax: 100,
          fillColor: '#3b82f6',
          fillWarningThreshold: 70,
          fillCriticalThreshold: 90,
        },
      }),
    ];

    const warning = evaluate(rules, { sensor1: 75 });
    expect(warning.fillColor).toBe('#eab308');

    const critical = evaluate(rules, { sensor1: 95 });
    expect(critical.fillColor).toBe('#ef4444');
  });

  it('activates blink when rule matches (interval + colors)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'blink',
        options: {
          blinkInterval: 500,
          fillA: '#ff0000',
          fillB: '#00ff00',
          strokeA: '#aa0000',
          strokeB: '#00aa00',
        },
      }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.blinking).toBe(true);
    expect(state.blinkInterval).toBe(500);
    expect(state.blinkFillA).toBe('#ff0000');
    expect(state.blinkFillB).toBe('#00ff00');
    expect(state.blinkStrokeA).toBe('#aa0000');
    expect(state.blinkStrokeB).toBe('#00aa00');
  });

  it('uses default blink interval when not specified', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'blink', options: {} }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.blinking).toBe(true);
    expect(state.blinkInterval).toBe(1000);
  });

  it('applies bitmask before evaluation', () => {
    // Value 0xFF (255), bitmask 0xF0 (240) -> masked = 0xF0, shift 4 -> effective = 15
    const rules: AnimationRule[] = [
      makeRule({
        type: 'colorRange',
        bitmask: 0xF0,
        range: { min: 0, max: 15 },
        options: {
          ranges: [
            { min: 0, max: 7, fill: '#green' },
            { min: 8, max: 15, fill: '#red' },
          ],
        },
      }),
    ];
    const state = evaluate(rules, { sensor1: 0xFF });
    expect(state.fill).toBe('#red');
  });

  it('applies bitmask correctly for lower bits', () => {
    // Value 0xFF (255), bitmask 0x0F (15) -> masked = 0x0F, shift 0 -> effective = 15
    const rules: AnimationRule[] = [
      makeRule({
        type: 'colorRange',
        bitmask: 0x0F,
        range: { min: 0, max: 15 },
        options: {
          ranges: [
            { min: 0, max: 7, fill: '#green' },
            { min: 8, max: 15, fill: '#red' },
          ],
        },
      }),
    ];
    const state = evaluate(rules, { sensor1: 0xFF });
    expect(state.fill).toBe('#red');
  });

  it('applies move when in range (toX, toY, duration)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'move',
        options: { toX: 100, toY: -50, duration: 800 },
      }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.translateX).toBe(100);
    expect(state.translateY).toBe(-50);
    expect(state.transitionDuration).toBe(800);
  });

  it('uses default move values when not specified', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'move', options: {} }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.translateX).toBe(0);
    expect(state.translateY).toBe(0);
    expect(state.transitionDuration).toBe(500);
  });

  it('does NOT activate when value is outside range', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'rotate',
        range: { min: 50, max: 100 },
        options: { rotationSpeed: 1000 },
      }),
    ];
    // Value 25 is outside range [50, 100]
    const state = evaluate(rules, { sensor1: 25 });
    expect(state.rotating).toBe(false);
    expect(state.rotationSpeed).toBe(2000); // default, not 1000
  });

  it('handles boolean tag values (true -> 1, false -> 0)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'hide',
        range: { min: 1, max: 1 },
      }),
    ];

    const trueState = evaluate(rules, { sensor1: true });
    expect(trueState.visible).toBe(false);

    const falseState = evaluate(rules, { sensor1: false });
    expect(falseState.visible).toBe(true); // false -> 0, outside range [1,1]
  });

  it('handles undefined tag values gracefully (skip rule)', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'hide',
        tagName: 'missing_sensor',
        range: { min: 0, max: 100 },
      }),
    ];
    const state = evaluate(rules, { sensor1: 50 });
    expect(state.visible).toBe(true); // rule skipped because tagName not in tagValues
  });

  it('handles NaN tag values gracefully (skip rule)', () => {
    const rules: AnimationRule[] = [
      makeRule({ type: 'hide', range: { min: 0, max: 100 } }),
    ];
    const state = evaluate(rules, { sensor1: 'not-a-number' });
    expect(state.visible).toBe(true); // rule skipped because NaN
  });

  it('multiple rules on different tags compose correctly', () => {
    const rules: AnimationRule[] = [
      makeRule({
        id: 'rule-1',
        type: 'rotate',
        tagName: 'pump_status',
        range: { min: 1, max: 1 },
        options: { rotationSpeed: 1500, direction: 'ccw' },
      }),
      makeRule({
        id: 'rule-2',
        type: 'colorRange',
        tagName: 'temperature',
        range: { min: 0, max: 100 },
        options: {
          ranges: [
            { min: 0, max: 30, fill: '#22c55e' },
            { min: 31, max: 100, fill: '#ef4444' },
          ],
        },
      }),
      makeRule({
        id: 'rule-3',
        type: 'blink',
        tagName: 'alarm',
        range: { min: 1, max: 1 },
        options: { blinkInterval: 250, fillA: '#ff0000', fillB: '#000000' },
      }),
      makeRule({
        id: 'rule-4',
        type: 'fillLevel',
        tagName: 'tank_level',
        range: { min: 0, max: 1000 },
        options: { fillMin: 0, fillMax: 500, fillColor: '#3b82f6' },
      }),
    ];

    const state = evaluate(rules, {
      pump_status: 1,
      temperature: 45,
      alarm: 1,
      tank_level: 250,
    });

    // rotate applied
    expect(state.rotating).toBe(true);
    expect(state.rotationSpeed).toBe(1500);
    expect(state.rotationDirection).toBe('ccw');

    // colorRange applied
    expect(state.fill).toBe('#ef4444');

    // blink applied
    expect(state.blinking).toBe(true);
    expect(state.blinkInterval).toBe(250);
    expect(state.blinkFillA).toBe('#ff0000');
    expect(state.blinkFillB).toBe('#000000');

    // fillLevel applied: 250 out of 0-500 = 50%
    expect(state.fillPercent).toBe(50);
    expect(state.fillColor).toBe('#3b82f6');

    // still visible (no hide rule)
    expect(state.visible).toBe(true);
  });

  it('string numeric tag values are coerced to numbers', () => {
    const rules: AnimationRule[] = [
      makeRule({
        type: 'fillLevel',
        range: { min: 0, max: 100 },
        options: { fillMin: 0, fillMax: 100 },
      }),
    ];
    const state = evaluate(rules, { sensor1: '75' });
    expect(state.fillPercent).toBe(75);
  });
});
