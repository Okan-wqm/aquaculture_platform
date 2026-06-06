import type { DeffeyesPHChartData } from '@platform/aquaculture-engines';
import {
  alkMgToMeq,
  generateDeffeyesPHChartData,
} from '@platform/aquaculture-engines';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import DeffeyesPhChart from './DeffeyesPhChart';

function makeChartData(): DeffeyesPHChartData {
  return generateDeffeyesPHChartData(
    { tempC: 12, pH: 7, salinity: 1, alkalinity: alkMgToMeq(80) },
    { targetpH: 7.5, targetAlkalinity: alkMgToMeq(100) },
    {
      tanMgL: 0.5,
      unIonizedNH3MgL: 0.0125,
      co2ToxicMgL: 40,
      h2sMeasuredUgL: 15,
      h2sLimitUgL: 25,
      currentPH: 7,
    },
    alkMgToMeq(50),
    alkMgToMeq(100),
    400
  );
}

describe('DeffeyesPhChart', () => {
  it('renders the DIC/pH chart with all risk overlay controls', () => {
    render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart data={makeChartData()} />
      </div>
    );

    expect(screen.getByTestId('deffeyes-ph-chart')).toHaveAttribute('data-report-chart-id', 'deffeyes');
    expect(screen.getByText('Water Quality Management Chart')).toBeInTheDocument();
    expect(screen.getByText('DIC / CT (mmol/L)')).toBeInTheDocument();
    expect(screen.getByText('pH (NBS)')).toBeInTheDocument();

    expect(screen.getByLabelText('Alkalinity Lines')).toBeChecked();
    expect(screen.getByLabelText('Safe Zone')).toBeChecked();
    expect(screen.getByLabelText('NH₃ Toxic')).toBeChecked();
    expect(screen.getByLabelText('CO₂ Toxic')).toBeChecked();
    expect(screen.getByLabelText('H₂S Toxic')).toBeChecked();
    expect(screen.getByLabelText('Ω Calcite/Ar')).not.toBeChecked();
  }, 15000);

  it('allows H2S coloring and on-demand overlays to be toggled', async () => {
    const user = userEvent.setup();
    const data = makeChartData();

    render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart
          data={data}
          onDemandPath={[
            data.currentPoint,
            { CT: data.currentPoint.CT + 0.2, pH: data.currentPoint.pH - 0.1, AT: data.currentPoint.AT },
          ]}
        />
      </div>
    );

    const h2sToggle = screen.getByLabelText('H₂S Toxic');
    const onDemandToggle = screen.getByLabelText('On-Demand');

    expect(h2sToggle).toBeChecked();
    expect(onDemandToggle).toBeChecked();
    expect(screen.getByTestId('deffeyes-layer-h2s-toxic')).toBeInTheDocument();

    await user.click(h2sToggle);
    await user.click(onDemandToggle);

    expect(h2sToggle).not.toBeChecked();
    expect(onDemandToggle).not.toBeChecked();
    expect(screen.queryByTestId('deffeyes-layer-h2s-toxic')).not.toBeInTheDocument();
  });

  it('renders NH3, CO2, H2S, current, target, and segmented on-demand layers', () => {
    const data = makeChartData();
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart
          data={data}
          onDemandSegments={[
            [
              data.currentPoint,
              { CT: data.currentPoint.CT + 0.2, pH: data.currentPoint.pH - 0.1, AT: data.currentPoint.AT },
            ],
            [
              { CT: data.currentPoint.CT + 0.3, pH: data.currentPoint.pH - 0.12, AT: data.currentPoint.AT },
              { CT: data.currentPoint.CT + 0.4, pH: data.currentPoint.pH - 0.15, AT: data.currentPoint.AT },
            ],
          ]}
        />
      </div>
    );

    expect(screen.getByLabelText('On-Demand')).toBeChecked();
    expect(screen.getByTestId('deffeyes-layer-safe-zone')).toBeInTheDocument();
    expect(screen.getByTestId('deffeyes-layer-co2-toxic')).toBeInTheDocument();
    expect(screen.getByTestId('deffeyes-layer-h2s-toxic')).toBeInTheDocument();
    expect(screen.getByTestId('deffeyes-layer-nh3-toxic')).toBeInTheDocument();
    expect(container.querySelector('polygon[fill="#2563eb"][stroke="#1d4ed8"]')).toBeInTheDocument();
    expect(container.querySelector('line[stroke="#111827"]')).toBeInTheDocument();
  });

  it('keeps a single reagent path segmented instead of flattening across gaps', () => {
    const data = makeChartData();
    const segment1 = [
      { CT: data.currentPoint.CT, pH: data.currentPoint.pH, AT: data.currentPoint.AT },
      { CT: data.currentPoint.CT + 0.1, pH: data.currentPoint.pH + 0.1, AT: data.currentPoint.AT },
    ];
    const segment2 = [
      { CT: data.currentPoint.CT + 0.8, pH: data.currentPoint.pH + 0.4, AT: data.currentPoint.AT },
      { CT: data.currentPoint.CT + 0.9, pH: data.currentPoint.pH + 0.5, AT: data.currentPoint.AT },
    ];

    render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart
          data={{
            ...data,
            reagentLine: [...segment1, ...segment2],
            reagentLineSegments: [segment1, segment2],
          }}
        />
      </div>
    );

    expect(screen.getByTestId('deffeyes-ph-chart')).toHaveAttribute('data-reagent-line-segments', '2');
  });

  it('forces toxic overlays back on for report export even after screen toggles are off', async () => {
    const user = userEvent.setup();
    const data = makeChartData();
    const { rerender } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart data={data} />
      </div>
    );

    await user.click(screen.getByLabelText('H₂S Toxic'));
    expect(screen.queryByTestId('deffeyes-layer-h2s-toxic')).not.toBeInTheDocument();

    rerender(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart data={data} forceSafetyOverlays />
      </div>
    );

    expect(screen.getByTestId('deffeyes-layer-h2s-toxic')).toBeInTheDocument();
  }, 15000);

  it('keeps target path visible when only the current marker is toggled off', async () => {
    const user = userEvent.setup();
    const data = makeChartData();
    const { container } = render(
      <div style={{ width: 900, height: 760 }}>
        <DeffeyesPhChart data={data} />
      </div>
    );

    await user.click(screen.getByLabelText('Current'));

    expect(screen.getByLabelText('Current')).not.toBeChecked();
    expect(screen.getByLabelText('Target')).toBeChecked();
    expect(container.querySelector('path[stroke="#6b7280"]')).toBeInTheDocument();
  }, 15000);

  it('keeps the toggle bar usable at narrow widths', () => {
    render(
      <div style={{ width: 320, height: 760 }}>
        <DeffeyesPhChart data={makeChartData()} />
      </div>
    );

    expect(screen.getByLabelText('Alkalinity Lines')).toBeInTheDocument();
    expect(screen.getByLabelText('Safe Zone')).toBeInTheDocument();
    expect(screen.getByLabelText('NH₃ Toxic')).toBeInTheDocument();
    expect(screen.getByLabelText('CO₂ Toxic')).toBeInTheDocument();
    expect(screen.getByLabelText('H₂S Toxic')).toBeInTheDocument();
    expect(screen.getByTestId('deffeyes-layer-toggle-bar').className).toContain('flex-wrap');
  });
});
