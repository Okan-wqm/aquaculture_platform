/**
 * Sample figures of the Budget tab — there is no budget per cost centre in
 * farm-service yet (FARM-MEDIUM-439). Rendered only through MockPreview, which
 * draws the notice naming the finding beside them.
 *
 * The figures are the Tenant Console D6 design's (tenant-fin.js `CC`,
 * `ACTUAL`), in thousands of TRY, for 1–14 October 2026. Replace this file
 * with the budget query once it exists; web-preview-data-path fails the build
 * when the finding is resolved and this file is still here.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { BudgetSample } from '../model/budgetModel';

const SITE_MANAGER = { en: 'Site manager', tr: 'Saha yöneticisi' };
const TENANT_ADMIN = { en: 'Tenant admin', tr: 'Tenant yöneticisi' };

const SAMPLE: BudgetSample = {
  currency: 'TRY',
  month: { year: 2026, month: 10 },
  dayOfMonth: 14,
  centres: [
    {
      code: 'AQ',
      name: { en: 'Aquaculture production', tr: 'Su ürünleri üretimi' },
      owner: SITE_MANAGER,
      budget: 4200,
      actual: 2050,
    },
    {
      code: 'HAT',
      name: { en: 'Hatchery', tr: 'Kuluçkahane' },
      owner: SITE_MANAGER,
      budget: 620,
      actual: 262,
    },
    {
      code: 'GH',
      name: { en: 'Greenhouse', tr: 'Sera' },
      owner: SITE_MANAGER,
      budget: 540,
      actual: 318,
    },
    {
      code: 'MNT',
      name: { en: 'Maintenance & equipment', tr: 'Bakım ve ekipman' },
      owner: SITE_MANAGER,
      budget: 380,
      actual: 151,
    },
    {
      code: 'HR',
      name: { en: 'Human resources', tr: 'İnsan kaynakları' },
      owner: TENANT_ADMIN,
      budget: 260,
      actual: 112,
    },
    {
      code: 'ADM',
      name: { en: 'General administration', tr: 'Genel yönetim' },
      owner: TENANT_ADMIN,
      budget: 300,
      actual: 131,
    },
  ],
};

export const BUDGET_PREVIEW = definePreviewData(
  {
    finding: 'FARM-MEDIUM-439',
    reasonKey: 'finance.budget.previewReason',
    needs:
      'farm-service budget per cost centre: entity, budgetVsActual query and setBudget mutation',
  },
  SAMPLE,
);
