/**
 * Finance › Cost centres (`/sites/finance?tab=cost-centres`).
 *
 * farm-service has no cost centre bound to the location tree and no
 * allocation key yet (FARM-MEDIUM-440): an expense carries a category, a site
 * and a batch only. So both parts of this tab — the register and unit
 * production cost per site — are sample data, reachable only through
 * MockPreview, whose notice names the finding and describes them.
 */
import { MockPreview } from '@aquaculture/shared-ui';
import React from 'react';

import { COST_CENTRES_PREVIEW } from '../preview/costCentres.preview';

import { CostCentreRegister } from './CostCentreRegister';
import { UnitCostTable } from './UnitCostTable';

export function CostCentresTab(): React.ReactElement {
  return (
    <MockPreview data={COST_CENTRES_PREVIEW} variant="block">
      {(sample) => (
        <div className="flex flex-col gap-8 p-4 sm:p-5">
          <CostCentreRegister centres={sample.centres} note={sample.registerNote} />
          <UnitCostTable sample={sample} />
        </div>
      )}
    </MockPreview>
  );
}
