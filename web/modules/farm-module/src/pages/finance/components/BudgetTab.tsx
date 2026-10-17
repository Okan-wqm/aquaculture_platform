/**
 * Finance › Budget (`/sites/finance?tab=budget`).
 *
 * farm-service has no budget per cost centre yet (FARM-MEDIUM-439), so every
 * figure on this tab is sample data, reachable only through MockPreview: the
 * notice naming the finding is drawn above the figures and describes them.
 * Real spend is on the Overview and Expenses tabs; it is not mixed in here
 * because no expense carries a cost centre to total it by (FARM-MEDIUM-440).
 */
import { MockPreview } from '@aquaculture/shared-ui';
import React from 'react';

import { BUDGET_PREVIEW } from '../preview/budget.preview';

import { BudgetFigures } from './BudgetFigures';

export function BudgetTab(): React.ReactElement {
  return (
    <MockPreview data={BUDGET_PREVIEW} variant="block">
      {(sample) => <BudgetFigures sample={sample} />}
    </MockPreview>
  );
}
