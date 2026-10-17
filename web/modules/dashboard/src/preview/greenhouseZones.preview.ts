/**
 * Sample zones of the Greenhouse dashboard's site table (FARM-MEDIUM-443):
 * hydroponics-service stores no greenhouse zones, nutrient readings or dosing
 * state, so these rows render only through MockPreview, beside the notice
 * naming the finding. The figures follow the Tenant Console D6 design's Söke
 * greenhouse (EC 3.4 against 2.0–2.8 in zone 2, air 24.5 °C against 22–26).
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { GreenhouseZoneRow } from '../model/greenhouse';

const ZONES: readonly GreenhouseZoneRow[] = [
  {
    id: 'sample-zone-1',
    code: 'GH-1 · Z1',
    name: 'Söke · Zone 1',
    ecMax: 2.6,
    ecTarget: [2.0, 2.8],
    ph: 6.0,
    airC: 24.1,
    airTarget: [22, 26],
    dosing: 'running',
  },
  {
    id: 'sample-zone-2',
    code: 'GH-1 · Z2',
    name: 'Söke · Zone 2',
    ecMax: 3.4,
    ecTarget: [2.0, 2.8],
    ph: 6.3,
    airC: 24.5,
    airTarget: [22, 26],
    dosing: 'paused',
  },
];

export const GREENHOUSE_ZONES_PREVIEW = definePreviewData(
  {
    finding: 'FARM-MEDIUM-443',
    reasonKey: 'dashboard.greenhouse.previewReason',
    needs:
      'hydroponics-service greenhouse zones bound to farm sites, with live EC, pH and air temperature against their targets, and the dosing state',
  },
  ZONES,
);
