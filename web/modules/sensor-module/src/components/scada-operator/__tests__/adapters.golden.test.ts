/**
 * Golden tests for the builder → runtime adapters (T7c).
 * Each case pins the exact output shape so silent mapping drift breaks CI.
 */

import { describe, it, expect } from 'vitest';

import {
  adaptWidgetPermissions,
  adaptWidgetEvents,
  adaptAnimationRules,
} from '../adapters';
import type { WidgetEventDef } from '../../../engine/events/types';
import type { AnimationRule } from '../../../engine/animation/types';

describe('permissionsAdapter (golden)', () => {
  it('maps tenant role ids that normalize to HmiRole literals', () => {
    const result = adaptWidgetPermissions({
      showRoles: ['ADMIN', 'role_operator'],
      enableRoles: ['hmi_engineer'],
    });
    expect(result.permission).toEqual({
      showRoles: ['admin', 'operator'],
      enabledRoles: ['engineer'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('keeps empty lists fully open (no confirm escalation)', () => {
    const result = adaptWidgetPermissions({ showRoles: [], enableRoles: [] });
    expect(result.permission).toEqual({ showRoles: [], enabledRoles: [] });
    expect(result.warnings).toEqual([]);
  });

  it('drops unresolvable tenant role ids with a visible warning (fail-open)', () => {
    const result = adaptWidgetPermissions({
      showRoles: ['3f9c2e1a-uuid-role'],
      enableRoles: [],
    });
    expect(result.permission.showRoles).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('3f9c2e1a-uuid-role');
    expect(result.warnings[0]).toContain('showRoles');
  });

  it('undefined permissions adapt to the fully-open default', () => {
    expect(adaptWidgetPermissions(undefined)).toEqual({
      permission: { showRoles: [], enabledRoles: [] },
      warnings: [],
    });
  });
});

describe('eventsAdapter (golden)', () => {
  it('maps targetScreenId → screenId and targetTag → tagId', () => {
    const defs: WidgetEventDef[] = [
      {
        id: 'evt-1',
        trigger: 'click',
        action: 'navigate',
        params: { targetScreenId: 'screen-main' },
      },
      {
        id: 'evt-2',
        trigger: 'dblclick',
        action: 'setValue',
        params: { targetTag: 'DEV01/pump', value: 1 },
      },
    ];

    const result = adaptWidgetEvents(defs);
    expect(result.warnings).toEqual([]);
    expect(result.events).toEqual([
      {
        id: 'evt-1',
        trigger: 'click',
        action: 'navigate',
        params: { type: 'navigate', screenId: 'screen-main' },
      },
      {
        id: 'evt-2',
        trigger: 'dblclick',
        action: 'setValue',
        params: { type: 'setValue', tagId: 'pump', value: 1 },
      },
    ]);
  });

  it('maps openUrl → openTab and closeDialog → close', () => {
    const result = adaptWidgetEvents([
      { id: 'a', trigger: 'click', action: 'openUrl', params: { url: 'https://example.com' } },
      { id: 'b', trigger: 'click', action: 'closeDialog', params: {} },
    ]);
    expect(result.events.map((e) => [e.action, e.params.type])).toEqual([
      ['openTab', 'openTab'],
      ['close', 'close'],
    ]);
  });

  it('reports unmapped actions visibly instead of silently dropping them', () => {
    const result = adaptWidgetEvents([
      { id: 'c', trigger: 'click', action: 'setProperty', params: { propertyPath: 'fill' } },
    ]);
    expect(result.events).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('setProperty');
    expect(result.warnings[0]).toContain('no runtime mapping');
  });
});

describe('animationsAdapter (golden)', () => {
  it('maps valueMappedRotation → rotate with angle params', () => {
    const rule: AnimationRule = {
      id: 'rot-1',
      tagName: 'valve_position',
      range: { min: 0, max: 100 },
      type: 'valueMappedRotation',
      options: { minAngle: 0, maxAngle: 270 },
    };
    const result = adaptAnimationRules([rule]);
    expect(result.warnings).toEqual([]);
    expect(result.actions).toEqual([
      {
        id: 'rot-1',
        tagId: 'valve_position',
        bitmask: undefined,
        range: { min: 0, max: 100 },
        type: 'rotate',
        params: { minAngle: 0, maxAngle: 270 },
      },
    ]);
  });

  it('maps colorRange to one color action per range', () => {
    const rule: AnimationRule = {
      id: 'col-1',
      tagName: 'TEMP/device1',
      range: { min: 0, max: 100 },
      type: 'colorRange',
      options: {
        ranges: [
          { min: 0, max: 50, fill: '#22c55e' },
          { min: 50, max: 100, fill: '#ef4444', stroke: '#7f1d1d' },
        ],
      },
    };
    const result = adaptAnimationRules([rule]);
    expect(result.actions.map((a) => a.type)).toEqual(['color', 'color']);
    // TagRef reduced to the device-local name.
    expect(result.actions[0].tagId).toBe('device1');
    expect(result.actions[1].params).toEqual({ fill: '#ef4444', stroke: '#7f1d1d' });
  });

  it('degrades unmapped rule types with a visible warning', () => {
    const rule: AnimationRule = {
      id: 'p-1',
      tagName: 'motor',
      range: { min: 0, max: 1 },
      type: 'piston',
      options: {},
    };
    const result = adaptAnimationRules([rule]);
    expect(result.actions).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('piston');
    expect(result.warnings[0]).toContain('degraded');
  });

  it('returns empty for undefined rules', () => {
    expect(adaptAnimationRules(undefined)).toEqual({ actions: [], warnings: [] });
  });
});
