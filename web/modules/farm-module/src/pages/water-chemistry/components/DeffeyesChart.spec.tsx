import type { DeffeyesChartData } from '@platform/aquaculture-engines';
import {
  alkMgToMeq,
  generateDeffeyesChartData,
  REAGENTS,
  reagentDirectionLine,
} from '@platform/aquaculture-engines';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import DeffeyesChart from './DeffeyesChart';

function makeLegacyData(): DeffeyesChartData {
  return generateDeffeyesChartData(
    { tempC: 12, pH: 7, salinity: 1, alkalinity: alkMgToMeq(80) },
    { targetpH: 7.5, targetAlkalinity: alkMgToMeq(100) },
    { tan: 0.5, unIonizedNH3: 0.0125, co2Toxic: 40, h2s: 0 },
    alkMgToMeq(50),
    alkMgToMeq(100),
    400
  );
}

describe('DeffeyesChart', () => {
  it('keeps the target path visible when only the current marker is toggled off', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart data={makeLegacyData()} />
      </div>
    );

    await user.click(screen.getByLabelText('Current'));

    expect(screen.getByLabelText('Current')).not.toBeChecked();
    expect(screen.getByLabelText('Target')).toBeChecked();
    expect(container.querySelector('path[stroke="#6b7280"]')).toBeInTheDocument();
  }, 15000);

  it('hides the single-reagent line when Dosing Path is toggled off', async () => {
    const user = userEvent.setup();
    const data = makeLegacyData();
    const reagent = REAGENTS.find(candidate => candidate.name === 'Sodium Bicarbonate');
    expect(reagent).toBeDefined();
    if (!reagent) throw new Error('Sodium Bicarbonate reagent fixture is missing');

    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart
          data={{
            ...data,
            reagentLine: reagentDirectionLine(
              data.currentPoint.DIC,
              data.currentPoint.ALK,
              reagent,
              8
            ),
          }}
        />
      </div>
    );

    expect(container.querySelector('path[stroke="#f59e0b"]')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Dosing Path'));

    expect(screen.getByLabelText('Dosing Path')).not.toBeChecked();
    expect(container.querySelector('path[stroke="#f59e0b"]')).not.toBeInTheDocument();
  }, 15000);
});
