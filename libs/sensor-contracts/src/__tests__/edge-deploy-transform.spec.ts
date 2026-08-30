import {
  EDGE_REJECTED_WIDGET_TYPES,
  EDGE_SUPPORTED_WIDGET_TYPES,
  classifyWidgetTypeForEdge,
  transformScadaDocForEdgeDeploy,
  type ScadaPackageDocV2,
} from '../index';

/**
 * CONTRACT-H-002 — the publish-boundary widget transform.
 *
 * The edge parses a closed 16-type widget set; the builder emits ~53.
 * The transform strips decorative/display-only widgets, REJECTS
 * control-semantics widgets (naming every violator, not first-fail), and
 * normalizes the fields the Rust structs require but the open save
 * contract does not (screen name/screenType, alarm severity/message).
 * It is pure (never mutates its input) and idempotent.
 */

function doc(overrides: Partial<ScadaPackageDocV2> = {}): ScadaPackageDocV2 {
  return {
    meta: { schemaVersion: 2, packageName: 'P' },
    screens: [
      {
        id: 's1',
        name: 'Main',
        screenType: 'dashboard',
        widgets: [
          {
            id: 'w-gauge',
            widgetType: 'gauge',
            position: { col: 0, row: 0, w: 2, h: 2 },
            config: { tagRef: 'EDGE-01/water_temp' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('classifyWidgetTypeForEdge', () => {
  it('classifies every supported type as ship', () => {
    for (const t of EDGE_SUPPORTED_WIDGET_TYPES) {
      expect(classifyWidgetTypeForEdge(t)).toBe('ship');
    }
  });

  it('classifies every control-semantics type as reject', () => {
    for (const t of EDGE_REJECTED_WIDGET_TYPES) {
      expect(classifyWidgetTypeForEdge(t)).toBe('reject');
    }
  });

  it('classifies decorative, display-only and UNKNOWN types as strip', () => {
    for (const t of ['staticText', 'svgRect', 'progressBar', 'fuxaWidget', 'someFutureType']) {
      expect(classifyWidgetTypeForEdge(t)).toBe('strip');
    }
  });

  it('ship and reject rosters are disjoint', () => {
    const ship = new Set<string>(EDGE_SUPPORTED_WIDGET_TYPES);
    for (const t of EDGE_REJECTED_WIDGET_TYPES) {
      expect(ship.has(t)).toBe(false);
    }
  });
});

describe('transformScadaDocForEdgeDeploy', () => {
  it('refuses a doc with reject-class widgets, naming ALL violators across screens', () => {
    const input = doc({
      screens: [
        {
          id: 's1',
          name: 'Main',
          widgets: [
            { id: 'w1', widgetType: 'knob', position: { col: 0, row: 0, w: 1, h: 1 }, config: {} },
            { id: 'w2', widgetType: 'gauge', position: { col: 1, row: 0, w: 1, h: 1 }, config: {} },
          ],
        },
        {
          id: 's2',
          name: 'Drives',
          widgets: [
            {
              id: 'w3',
              widgetType: 'vfdDrive',
              position: { col: 0, row: 0, w: 2, h: 2 },
              config: {},
            },
          ],
        },
      ],
    });

    const result = transformScadaDocForEdgeDeploy(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejected).toEqual([
      { screenId: 's1', widgetId: 'w1', widgetType: 'knob' },
      { screenId: 's2', widgetId: 'w3', widgetType: 'vfdDrive' },
    ]);
  });

  it('strips decorative widgets out of the payload and reports each one', () => {
    const input = doc({
      screens: [
        {
          id: 's1',
          name: 'Main',
          widgets: [
            { id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 1, h: 1 }, config: {} },
            {
              id: 'w2',
              widgetType: 'staticText',
              position: { col: 1, row: 0, w: 1, h: 1 },
              config: { text: 'hi' },
            },
            {
              id: 'w3',
              widgetType: 'svgCircle',
              position: { col: 2, row: 0, w: 1, h: 1 },
              config: {},
            },
          ],
        },
      ],
    });

    const result = transformScadaDocForEdgeDeploy(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.doc.screens[0]?.widgets.map((w) => w.id)).toEqual(['w1']);
    expect(result.stripped).toEqual([
      { screenId: 's1', widgetId: 'w2', widgetType: 'staticText' },
      { screenId: 's1', widgetId: 'w3', widgetType: 'svgCircle' },
    ]);
  });

  it('fills the fields the Rust structs require: screen name/screenType, alarm severity/message', () => {
    // Persisted docs really do arrive without these fields (the save
    // contract is open) — the typed claim is bypassed per test convention.
    const input: ScadaPackageDocV2 = {
      meta: { schemaVersion: 2 },
      screens: [{ id: 's1', widgets: [] } as never],
      alarmRules: [
        { id: 'a1', tag: 'water_temp', condition: 'gt', value: 28, severity: 'HIGH' } as never,
        {
          id: 'a2',
          tag: 'do',
          condition: 'lt',
          value: 4,
          severity: 'fatal',
          message: 'DO critical',
        },
      ],
    };
    const result = transformScadaDocForEdgeDeploy(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const screen = result.doc.screens[0];
    expect(screen?.name).toBe('s1'); // defaulted to the id
    expect(screen?.screenType).toBe('dashboard'); // defaulted

    const [a1, a2] = result.doc.alarmRules ?? [];
    expect(a1?.severity).toBe('high'); // lowercased into the closed set
    expect(a1?.message).toBe('water_temp gt 28'); // synthesized
    expect(a2?.severity).toBe('warning'); // unknown severity → warning
    expect(a2?.message).toBe('DO critical'); // provided message preserved
  });

  it('normalizes screenType casing and defaults unknown values to dashboard', () => {
    const input = doc({
      screens: [
        { id: 's1', name: 'A', screenType: 'Process', widgets: [] },
        { id: 's2', name: 'B', screenType: 'weirdCustomType', widgets: [] },
      ],
    });
    const result = transformScadaDocForEdgeDeploy(input);
    if (!result.ok) throw new Error('unreachable');
    expect(result.doc.screens.map((s) => s.screenType)).toEqual(['process', 'dashboard']);
  });

  it('never mutates its input (upcaster discipline)', () => {
    const input = doc({
      screens: [
        {
          id: 's1',
          name: 'Main',
          widgets: [
            { id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 1, h: 1 }, config: {} },
            {
              id: 'w2',
              widgetType: 'staticText',
              position: { col: 1, row: 0, w: 1, h: 1 },
              config: {},
            },
          ],
        },
      ],
      alarmRules: [{ id: 'a1', tag: 't', condition: 'gt', value: 1, severity: 'HIGH' } as never],
    });
    const before: unknown = JSON.parse(JSON.stringify(input));

    transformScadaDocForEdgeDeploy(input);

    expect(input).toEqual(before);
  });

  it('is idempotent: re-transforming the output is a strip-free no-op', () => {
    const input = doc({
      alarmRules: [{ id: 'a1', tag: 't', condition: 'gt', value: 1, severity: 'HIGH' } as never],
    });
    const first = transformScadaDocForEdgeDeploy(input);
    if (!first.ok) throw new Error('unreachable');
    const second = transformScadaDocForEdgeDeploy(first.doc);
    if (!second.ok) throw new Error('unreachable');
    expect(second.stripped).toEqual([]);
    expect(second.doc).toEqual(first.doc);
  });

  it('does not add an alarmRules key the input never had', () => {
    const input = doc();
    delete (input as Record<string, unknown>).alarmRules;
    const result = transformScadaDocForEdgeDeploy(input);
    if (!result.ok) throw new Error('unreachable');
    expect('alarmRules' in result.doc).toBe(false);
  });
});
