/**
 * Sample figures of the Cost centres tab — farm-service has no cost centre
 * bound to the location tree and no allocation key yet (FARM-MEDIUM-440).
 * Rendered only through MockPreview, which draws the notice naming the
 * finding beside them.
 *
 * The register and the unit costs are the Tenant Console D6 design's
 * (tenant-fin.js `CC`, `UNIT`), in thousands of TRY, for 1–14 October 2026.
 * The two notes describe the model the sample shows (tenant-fin.js `ccNote`,
 * `costNote`) — no expense carries a cost centre yet — so they live here and
 * are deleted with the sample, never stated as fact in the locale catalogues.
 * Replace this file with the cost-centre queries once they exist;
 * web-preview-data-path fails the build when the finding is resolved and this
 * file is still here.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { CostCentresSample } from '../model/costCentreModel';

const AYVALIK = { en: 'Ayvalık', tr: 'Ayvalık' };
const BODRUM = { en: 'Bodrum', tr: 'Bodrum' };
const KALKAN = { en: 'Kalkan', tr: 'Kalkan' };
const SOKE = { en: 'Söke', tr: 'Söke' };
const HEAD_OFFICE = { en: 'Head office', tr: 'Merkez' };
const SITE_MANAGER = { en: 'Site manager', tr: 'Saha yöneticisi' };
const TENANT_ADMIN = { en: 'Tenant admin', tr: 'Tenant yöneticisi' };
const TONNES = { en: 't', tr: 't' };
const PER_KG = { en: '₺/kg', tr: '₺/kg' };

const SAMPLE: CostCentresSample = {
  currency: 'TRY',
  period: { year: 2026, month: 10, fromDay: 1, toDay: 14 },
  centres: [
    {
      code: 'AQ',
      name: { en: 'Aquaculture production', tr: 'Su ürünleri üretimi' },
      sites: [AYVALIK, KALKAN],
      owner: SITE_MANAGER,
    },
    {
      code: 'HAT',
      name: { en: 'Hatchery', tr: 'Kuluçkahane' },
      sites: [BODRUM],
      owner: SITE_MANAGER,
    },
    { code: 'GH', name: { en: 'Greenhouse', tr: 'Sera' }, sites: [SOKE], owner: SITE_MANAGER },
    {
      code: 'MNT',
      name: { en: 'Maintenance & equipment', tr: 'Bakım ve ekipman' },
      sites: [AYVALIK, BODRUM, KALKAN, SOKE],
      owner: SITE_MANAGER,
    },
    {
      code: 'HR',
      name: { en: 'Human resources', tr: 'İnsan kaynakları' },
      sites: [HEAD_OFFICE],
      owner: TENANT_ADMIN,
    },
    {
      code: 'ADM',
      name: { en: 'General administration', tr: 'Genel yönetim' },
      sites: [HEAD_OFFICE],
      owner: TENANT_ADMIN,
    },
  ],
  registerNote: {
    en: 'Every expense is tagged with one cost centre and one site.',
    tr: 'Her gider tek bir maliyet merkezine ve sahaya etiketlenir.',
  },
  unitCosts: [
    {
      site: AYVALIK,
      centreCode: 'AQ',
      output: 21.4,
      outputUnit: TONNES,
      cost: 1380,
      target: 62,
      unit: PER_KG,
      feedShare: 0.58,
    },
    {
      site: KALKAN,
      centreCode: 'AQ',
      output: 11.2,
      outputUnit: TONNES,
      cost: 670,
      target: 62,
      unit: PER_KG,
      feedShare: 0.61,
    },
    {
      site: BODRUM,
      centreCode: 'HAT',
      output: 2.4,
      outputUnit: { en: 'M fry', tr: 'M yavru' },
      cost: 262,
      target: 115,
      unit: { en: '₺/1,000 fry', tr: '₺/1.000 yavru' },
      feedShare: 0.22,
    },
    {
      site: SOKE,
      centreCode: 'GH',
      output: 18.6,
      outputUnit: TONNES,
      cost: 318,
      target: 14,
      unit: PER_KG,
      feedShare: null,
    },
  ],
  unitNote: {
    en: 'Output = biomass gain or harvest in the period. HR and administration costs are not allocated to unit cost.',
    tr: 'Üretim = dönemdeki biyokütle artışı veya hasat. İK ve genel yönetim giderleri birim maliyete dağıtılmaz.',
  },
};

export const COST_CENTRES_PREVIEW = definePreviewData(
  {
    finding: 'FARM-MEDIUM-440',
    reasonKey: 'finance.costCentres.previewReason',
    needs:
      'farm-service cost centre bound to the location tree with allocation keys; costCentres and unitProductionCost queries',
  },
  SAMPLE,
);
