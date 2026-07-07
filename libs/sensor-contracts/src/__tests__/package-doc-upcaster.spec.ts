import { ScadaPackageDocV2, WidgetDoc } from '../scada-package-doc/scada-package-doc.types';
import { upcastScadaPackageDoc } from '../scada-package-doc/upcast';
import { validateScadaPackageDocV2 } from '../validators';

/** A representative legacy (V1) document as the pre-Faz2 serializer wrote it. */
const V1_DOC = {
  meta: {
    version: 1,
    packageName: 'RAS Ana Ekran',
    processId: 'proc-1',
    edgeDeviceId: 'device-uuid-1',
    automationBindings: [{ programId: 'p1', variableId: 'v1', boundWidgetId: 'w2' }],
  },
  screens: [
    {
      id: 'scr-1',
      name: 'Main',
      screenType: 'dashboard',
      isDefault: true,
      icon: 'LayoutDashboard',
      layout: { type: 'grid', cols: 24, rows: 16 },
      widgets: [
        // Builder-era binding: config.tagName (device-local)
        { id: 'w1', widgetType: 'gauge', position: { col: 0, row: 0, w: 4, h: 3 }, config: { tagName: 'tank1.do', min: 0, max: 20 } },
        // Operator-era binding: config.tagId
        { id: 'w2', widgetType: 'numeric', position: { col: 4, row: 0, w: 2, h: 2 }, config: { tagId: 'tank1.temp' } },
        // Already-full ref in a legacy key
        { id: 'w3', widgetType: 'sparkline', position: { col: 6, row: 0, w: 4, h: 2 }, config: { tag: 'EDGE-AABB1122/ph_sensor' } },
        // No binding at all
        { id: 'w4', widgetType: 'label', position: { col: 0, row: 3, w: 2, h: 1 }, config: { text: 'Tank 1' } },
      ],
    },
  ],
  alarmRules: [
    { id: 'a1', tag: 'tank1.do', condition: '<', value: 4, severity: 'critical', message: 'Low DO' },
  ],
  controlPermissions: { securityLevels: { none: [], confirm: [], pin: [] }, pinHash: null, emergencyStop: null },
  trendConfig: { retentionDays: 7, sampleIntervalSec: 60, tags: [] },
};

/** Safe widget accessors — no non-null assertions in this lib's lint policy. */
function widgetsOf(doc: ScadaPackageDocV2): WidgetDoc[] {
  return doc.screens[0]?.widgets ?? [];
}

function widgetAt(doc: ScadaPackageDocV2, index: number): WidgetDoc {
  const widget = widgetsOf(doc)[index];
  if (!widget) throw new Error(`fixture missing widget at index ${index}`);
  return widget;
}

describe('upcastScadaPackageDoc (V1 → V2)', () => {
  it('stamps schemaVersion 2 and preserves every other meta field', () => {
    const v2 = upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });

    expect(v2.meta.schemaVersion).toBe(2);
    expect(v2.meta.packageName).toBe('RAS Ana Ekran');
    expect(v2.meta.version).toBe(1);
    expect(v2.meta.automationBindings).toEqual(V1_DOC.meta.automationBindings);
  });

  it('canonicalises tagName and tagId into full tagRefs when deviceCode is known', () => {
    const v2 = upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });

    expect(widgetAt(v2, 0).config.tagRef).toBe('EDGE-AABB1122/tank1.do');
    expect(widgetAt(v2, 1).config.tagRef).toBe('EDGE-AABB1122/tank1.temp');
    // Already-full legacy ref adopted verbatim
    expect(widgetAt(v2, 2).config.tagRef).toBe('EDGE-AABB1122/ph_sensor');
    // Unbound widget stays unbound
    expect(widgetAt(v2, 3).config.tagRef).toBeUndefined();
    // Legacy keys are preserved for not-yet-migrated readers
    expect(widgetAt(v2, 0).config['tagName']).toBe('tank1.do');
    expect(widgetAt(v2, 1).config['tagId']).toBe('tank1.temp');
  });

  it('leaves device-local legacy names unpromoted without deviceCode context', () => {
    const v2 = upcastScadaPackageDoc(V1_DOC);

    expect(widgetAt(v2, 0).config.tagRef).toBeUndefined();
    expect(widgetAt(v2, 0).config['tagName']).toBe('tank1.do');
    // Full refs still adopt — no context needed
    expect(widgetAt(v2, 2).config.tagRef).toBe('EDGE-AABB1122/ph_sensor');
  });

  it('is idempotent: upcasting a V2 document changes nothing', () => {
    const once = upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });
    const twice = upcastScadaPackageDoc(once, { deviceCode: 'EDGE-AABB1122' });
    expect(twice).toEqual(once);
  });

  it('does not mutate the input document', () => {
    const frozen = structuredClone(V1_DOC);
    upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });
    expect(V1_DOC).toEqual(frozen);
  });

  it('produces a document that passes the V2 schema validator', () => {
    const v2 = upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });
    expect(validateScadaPackageDocV2(v2)).toBe(true);
  });

  it('rejects non-object documents', () => {
    expect(() => upcastScadaPackageDoc(null)).toThrow(TypeError);
    expect(() => upcastScadaPackageDoc('nope')).toThrow(TypeError);
    expect(() => upcastScadaPackageDoc([])).toThrow(TypeError);
  });

  it('tolerates an empty/degenerate document (empty screens, no meta)', () => {
    const v2 = upcastScadaPackageDoc({});
    expect(v2.meta.schemaVersion).toBe(2);
    expect(v2.screens).toEqual([]);
  });
});

describe('V2 schema validator', () => {
  it('rejects a document without meta.schemaVersion', () => {
    expect(validateScadaPackageDocV2(V1_DOC)).toBe(false);
  });

  it('rejects a widget with a malformed tagRef', () => {
    const v2 = upcastScadaPackageDoc(V1_DOC, { deviceCode: 'EDGE-AABB1122' });
    const broken = structuredClone(v2);
    widgetAt(broken, 0).config.tagRef = 'not a ref';
    expect(validateScadaPackageDocV2(broken)).toBe(false);
  });
});
