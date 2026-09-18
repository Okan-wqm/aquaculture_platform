/**
 * Serialization roundtrip invariant for the SCADA package document.
 *
 * Before Faz 2, `toScadaPackageJSON` silently dropped widget-level
 * `name`/`visible`/`zIndex`/`permissions` and screen-level backgrounds —
 * a save/reload cycle lost layer ordering, hidden-widget state, and
 * widget RBAC. This spec pins the contract:
 *   loadFromJSON(toScadaPackageJSON(state)) → toScadaPackageJSON() is a
 *   fixed point (deep-equal), for every serialized field.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createScadaStore } from '../createScadaStore';
import type { ScreenWidget } from '../types';
import type { AnimationRule } from '../../../engine/animation/types';
import type { WidgetEventDef } from '../../../engine/events/types';

type ScadaStoreApi = ReturnType<typeof createScadaStore>;

const fullWidget = (id: string, overrides: Partial<ScreenWidget> = {}): ScreenWidget => ({
  id,
  widgetType: 'gauge',
  position: { col: 1, row: 2, w: 4, h: 3 },
  config: { tagRef: 'EDGE-AABB1122/tank1.do', min: 0, max: 20 },
  name: `Widget ${id}`,
  groupId: 'grp-1',
  locked: true,
  visible: false,
  zIndex: 7,
  permissions: { showRoles: ['operator'], enableRoles: ['engineer'] },
  animations: [
    {
      id: `anim-${id}`,
      tagName: 'tank1.do',
      range: { min: 0, max: 1 },
      type: 'blink',
      options: { blinkInterval: 500 },
    } satisfies AnimationRule,
  ],
  events: [
    {
      id: `evt-${id}`,
      trigger: 'click',
      action: 'navigate',
      params: { targetScreenId: 'scr-2' },
    } satisfies WidgetEventDef,
  ],
  ...overrides,
});

describe('SCADA package serialization roundtrip', () => {
  let store: ScadaStoreApi;

  beforeEach(() => {
    store = createScadaStore();
  });

  it('serialize → load → serialize is a fixed point with ALL widget fields', () => {
    const state = store.getState();

    // Arrange a package exercising every serialized field.
    state.loadFromJSON({
      meta: {
        schemaVersion: 2,
        packageName: 'Roundtrip',
        processId: 'proc-9',
        edgeDeviceId: 'dev-9',
        // The real AutomationBinding shape. This fixture was flat —
        // `variableId` / `varName` / `boundWidgetId` at the top level, which are
        // VariableBinding's fields, not AutomationBinding's — and omitted BOTH
        // required members, `programName` and `variableBindings`. The blanket cast
        // carried it unchanged through the refactor that nested them, so the
        // fixed-point assertion below was round-tripping a shape the store's own
        // type cannot hold: whatever it does with those keys, it was not
        // exercising automation bindings.
        automationBindings: [
          {
            programId: 'p1',
            programName: 'DO Setpoint Control',
            programCode: 'PRG1',
            variableBindings: [
              {
                variableId: 'v1',
                varName: 'DO_SP',
                scope: 'OUTPUT',
                dataType: 'REAL',
                boundWidgetId: 'w1',
                boundTag: 'tank1.do_sp',
              },
            ],
          },
        ],
      },
      screens: [
        {
          id: 'scr-1',
          name: 'Ops',
          screenType: 'dashboard',
          isDefault: true,
          icon: 'LayoutDashboard',
          layout: { type: 'grid', cols: 24, rows: 16 },
          widgets: [fullWidget('w1'), fullWidget('w2', { zIndex: 0, visible: true, locked: false })],
          parentId: null,
          sortOrder: 3,
          backgroundImage: 'https://example.com/bg.png',
          backgroundOpacity: 0.5,
        },
      ],
      alarmRules: [
        { id: 'a1', tag: 'tank1.do', condition: '<', value: 4, severity: 'critical', message: 'Low DO', deadband: 0.2, delay: 5 },
      ],
      controlPermissions: {
        securityLevels: { none: ['label'], confirm: ['pump'], pin: ['feeder'] },
        pinHash: 'hash',
        emergencyStop: { holdDuration: 3, affectedTags: ['pump1'], resetRequiresPin: true },
      },
      trendConfig: { retentionDays: 14, sampleIntervalSec: 30, tags: ['tank1.do'] },
      scripts: [
        { id: 's1', name: 'onLoad', code: 'return 1;', trigger: 'load', enabled: true } as never,
      ],
    });

    const first = store.getState().toScadaPackageJSON();
    store.getState().loadFromJSON(JSON.parse(JSON.stringify(first)));
    const second = store.getState().toScadaPackageJSON();

    expect(second).toEqual(first);
  });

  it('preserves the previously-dropped fields through one save/load cycle', () => {
    const state = store.getState();
    state.loadFromJSON({
      meta: { schemaVersion: 2, packageName: 'X' },
      screens: [
        {
          id: 'scr-1',
          name: 'S',
          screenType: 'dashboard',
          isDefault: true,
          widgets: [fullWidget('w1')],
        },
      ],
    });

    const json = store.getState().toScadaPackageJSON();
    const widget = json.screens?.[0]?.widgets?.[0];
    if (!widget) throw new Error('fixture missing widget');

    expect(widget.name).toBe('Widget w1');
    expect(widget.visible).toBe(false);
    expect(widget.zIndex).toBe(7);
    expect(widget.permissions).toEqual({ showRoles: ['operator'], enableRoles: ['engineer'] });
    expect(json.meta?.schemaVersion).toBe(2);
  });

  it('upcasts legacy V1 docs on load: full-ref legacy bindings gain config.tagRef', () => {
    store.getState().loadFromJSON({
      meta: { packageName: 'Legacy' },
      screens: [
        {
          id: 'scr-1',
          name: 'S',
          screenType: 'dashboard',
          isDefault: true,
          widgets: [
            {
              id: 'w1',
              widgetType: 'gauge',
              position: { col: 0, row: 0, w: 2, h: 2 },
              config: { tag: 'EDGE-AABB1122/ph_sensor' },
            },
          ],
        },
      ],
    });

    const widget = store.getState().screens[0]!.widgets[0]!;
    expect(widget.config['tagRef']).toBe('EDGE-AABB1122/ph_sensor');
    // Legacy key preserved for not-yet-migrated readers
    expect(widget.config['tag']).toBe('EDGE-AABB1122/ph_sensor');
  });
});
