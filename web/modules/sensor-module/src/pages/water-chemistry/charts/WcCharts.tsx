/**
 * Per-card chart renderers (P2). Lean recharts renderers of engine data — a card
 * shows ONE of these by its `chartType`. Not a fork of farm-module's 926-line
 * DeffeyesChart (the full zone-shaded chart is a real-phase shared-ui promotion).
 * All fixed-height, isAnimationActive=false.
 */
import {
  criticalPHforCO2,
  criticalPHforH2SPHChartDomain,
  criticalPHforNH3,
  generateCarbonateVsPHData,
  generateDeffeyesChartData,
  generateH2SvsPHData,
  generateUIAvsPHData,
} from '@platform/aquaculture-engines';
import { type ReactElement, useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { EngineInputs } from '../engine-adapter';
import type { ChartType } from '../types';

function DeffeyesChart({ inputs }: { inputs: EngineInputs }): ReactElement {
  const d = useMemo(() => {
    const data = generateDeffeyesChartData(
      { tempC: inputs.tempC, pH: inputs.pH, salinity: inputs.salinity, alkalinity: inputs.alkalinityMeq },
      null,
      { tan: inputs.tan, unIonizedNH3: inputs.nh3Limit, co2Toxic: inputs.co2Toxic, h2sMeasuredUgL: inputs.h2sUgL, h2sLimitUgL: inputs.h2sLimitUgL, h2sMeasuredAtPH: inputs.pH },
      inputs.alkalinityMeq * 0.6,
      inputs.alkalinityMeq * 1.4,
      inputs.caMgL,
      false,
    );
    const isolines = data.isolines.filter((iso) => Number.isInteger(iso.pH * 2));
    return { isolines: isolines.length ? isolines : data.isolines, current: data.currentPoint };
  }, [inputs]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis type="number" dataKey="CT" domain={[0, 8]} tick={{ fontSize: 10 }} label={{ value: 'DIC (mmol/L)', position: 'insideBottom', fontSize: 10, dy: 10 }} />
        <YAxis type="number" domain={[0, 8]} tick={{ fontSize: 10 }} label={{ value: 'ALK (meq/L)', angle: -90, position: 'insideLeft', fontSize: 10 }} />
        {d.isolines.map((iso) => (
          <Line key={iso.pH} data={iso.points} dataKey="AT" stroke={iso.color} strokeWidth={0.8} dot={false} isAnimationActive={false} legendType="none" />
        ))}
        <ReferenceDot x={d.current.DIC} y={d.current.ALK} r={5} fill="#2563eb" stroke="#fff" strokeWidth={1.5} isFront />
      </LineChart>
    </ResponsiveContainer>
  );
}

function Nh3Chart({ inputs }: { inputs: EngineInputs }): ReactElement {
  const data = useMemo(() => generateUIAvsPHData(inputs.tempC, inputs.salinity, inputs.tan, inputs.nh3Limit), [inputs]);
  const crit = useMemo(() => criticalPHforNH3(inputs.tan, inputs.nh3Limit, inputs.tempC, inputs.salinity), [inputs]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="pH" type="number" domain={[6, 9.5]} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(3)} />
        <Tooltip formatter={(v: number) => `${v.toFixed(4)} mg/L`} />
        <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, fontSize: 9, fill: '#3b82f6', position: 'top' }} />
        {!Number.isNaN(crit) && <ReferenceLine x={crit} stroke="#ef4444" label={{ value: 'crit', fontSize: 9, fill: '#ef4444', position: 'top' }} />}
        <ReferenceLine y={inputs.nh3Limit} stroke="#f97316" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="UIA" name="NH₃-N" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function Co2Chart({ inputs }: { inputs: EngineInputs }): ReactElement {
  const data = useMemo(() => generateCarbonateVsPHData(inputs.tempC, inputs.salinity), [inputs]);
  const crit = useMemo(() => criticalPHforCO2(inputs.alkalinityMeq, inputs.co2Toxic, inputs.tempC, inputs.salinity), [inputs]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="pH" type="number" domain={[4, 12]} tick={{ fontSize: 10 }} />
        <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
        <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
        <Legend verticalAlign="top" height={22} wrapperStyle={{ fontSize: 10 }} />
        <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeDasharray="5 5" />
        {!Number.isNaN(crit) && <ReferenceLine x={crit} stroke="#ef4444" label={{ value: 'CO₂ crit', fontSize: 9, fill: '#ef4444', position: 'top' }} />}
        <Line type="monotone" dataKey="CO2" name="CO₂" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="HCO3" name="HCO₃⁻" stroke="#10b981" strokeWidth={1.6} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="CO3" name="CO₃²⁻" stroke="#8b5cf6" strokeWidth={1.6} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function H2sChart({ inputs }: { inputs: EngineInputs }): ReactElement {
  const data = useMemo(
    () => generateH2SvsPHData(inputs.tempC, inputs.salinity, Math.max(inputs.h2sUgL, 0.1), inputs.pH, inputs.h2sLimitUgL),
    [inputs],
  );
  const crit = useMemo(
    () => criticalPHforH2SPHChartDomain(Math.max(inputs.h2sUgL, 0.1), inputs.pH, inputs.h2sLimitUgL, inputs.tempC, inputs.salinity),
    [inputs],
  );
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="pH" type="number" domain={[4, 12.5]} tick={{ fontSize: 10 }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
        <Legend verticalAlign="top" height={22} wrapperStyle={{ fontSize: 10 }} />
        <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeDasharray="5 5" />
        {!Number.isNaN(crit) && <ReferenceLine x={crit} stroke="#ef4444" label={{ value: 'crit', fontSize: 9, fill: '#ef4444', position: 'top' }} />}
        <Line type="monotone" dataKey="H2S_pct" name="H₂S %" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="HS_pct" name="HS⁻ %" stroke="#06b6d4" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function WcChart({ inputs, chartType }: { inputs: EngineInputs; chartType: ChartType }): ReactElement {
  switch (chartType) {
    case 'nh3':
      return <Nh3Chart inputs={inputs} />;
    case 'co2':
      return <Co2Chart inputs={inputs} />;
    case 'h2s':
      return <H2sChart inputs={inputs} />;
    case 'deffeyes':
    default:
      return <DeffeyesChart inputs={inputs} />;
  }
}
