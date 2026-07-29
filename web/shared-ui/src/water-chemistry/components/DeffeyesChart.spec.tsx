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
    { tan: 0.5, unIonizedNH3: 0.0125, co2Toxic: 40, h2sMeasuredUgL: 15, h2sLimitUgL: 25, h2sMeasuredAtPH: 7 },
    alkMgToMeq(50),
    alkMgToMeq(100),
    400
  );
}

describe('DeffeyesChart', () => {
  it('labels DIC on the x-axis, alkalinity on the y-axis, and pH isolines inside the chart', () => {
    render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart data={makeLegacyData()} />
      </div>
    );

    expect(screen.getByText('DIC (mmol/L)')).toBeInTheDocument();
    expect(screen.getByText('Alkalinity (meq/L)')).toBeInTheDocument();
    expect(screen.getByText('pH 7.0')).toHaveAttribute('text-anchor', 'middle');
  });

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
  });

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
  });

  it('reveals the H₂S toxic zone only when its layer toggle is enabled', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart data={makeLegacyData()} />
      </div>
    );

    // Hidden by default, consistent with the NH₃ / CO₂ toxic layers.
    expect(screen.getByLabelText('H₂S Toxic')).not.toBeChecked();
    expect(container.querySelector('path[stroke="#b91c1c"]')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('H₂S Toxic'));

    expect(screen.getByLabelText('H₂S Toxic')).toBeChecked();
    expect(container.querySelector('path[stroke="#b91c1c"]')).toBeInTheDocument();
  });

  it('forces the toxic overlays (including H₂S) on for report export via forceSafetyOverlays', () => {
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart data={makeLegacyData()} forceSafetyOverlays />
      </div>
    );

    // The user toggle stays visually unchecked; the overlay renders because the
    // report export forces every toxicity band on.
    expect(screen.getByLabelText('H₂S Toxic')).not.toBeChecked();
    expect(container.querySelector('path[stroke="#b91c1c"]')).toBeInTheDocument();
  });

  it('overlays every measurement point on one chart and suppresses pH isolines beyond a single point', () => {
    const a = makeLegacyData();
    const b = makeLegacyData();
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesChart
          data={a}
          overlays={[
            { data: a, label: 'Biofilter inlet', color: '#ef4444' },
            { data: b, label: 'Tank 1', color: '#22c55e' },
          ]}
        />
      </div>
    );

    // Each point draws its own colored operating marker on the single chart...
    expect(container.querySelector('circle[fill="#ef4444"]')).toBeInTheDocument();
    expect(container.querySelector('circle[fill="#22c55e"]')).toBeInTheDocument();
    // ...and pH isolines (temp/salinity-specific) are hidden once more than one point overlays.
    expect(screen.queryByText('pH 7.0')).not.toBeInTheDocument();
  });
});
