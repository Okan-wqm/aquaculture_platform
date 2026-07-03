/**
 * Secondary water-chemistry charts (SSoT), extracted verbatim from farm-module's
 * WaterChemistryPage. Each is self-contained given { inputs, outputs } — it generates
 * its own recharts data from the pure engine and clamps its safety bands. Consumed by
 * the farm calculator and the sensor-module cards from the SOURCE subpath
 * (`@platform/shared-ui/water-chemistry/components`), like DeffeyesChart.
 */
import {
  alkMgToMeq,
  calcDicOfAlk,
  DEFFEYES_CHART_PH_DOMAIN,
  DEFFEYES_LEGACY_PH_DOMAIN,
  generateCarbonateVsPHData,
  generateH2SvsPHData,
  generateSaturationVsPHData,
  generateUIAvsPHData,
  percentNH3,
} from '@platform/aquaculture-engines';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { getVisibleH2SChartZones, getVisibleNH3ChartZones } from '../chart-zones';
import type { CalculatedOutputs, WaterChemistryInputs } from '../types';

interface ChartProps {
  inputs: WaterChemistryInputs;
  outputs: CalculatedOutputs;
}

export function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="bg-white rounded-lg shadow">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="p-4" style={{ height: 320 }}>
        {children}
      </div>
    </div>
  );
}

export function UiaVsPhChart({ inputs, outputs }: ChartProps): ReactElement {
  const uiaData = useMemo(
    () => generateUIAvsPHData(inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3),
    [inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3],
  );
  const zones = useMemo(() => getVisibleNH3ChartZones(outputs.toxicNH3pH, 6.0, 9.5), [outputs.toxicNH3pH]);
  const intersectionPoints = useMemo(() => {
    const points: Array<{ pH: number; UIA: number; color: string }> = [
      { pH: inputs.pH, UIA: outputs.currentUIA, color: '#3b82f6' },
    ];
    if (!isNaN(outputs.toxicNH3pH)) {
      points.push({ pH: outputs.toxicNH3pH, UIA: inputs.unIonizedNH3, color: '#ef4444' });
    }
    return points;
  }, [inputs.pH, inputs.unIonizedNH3, outputs.currentUIA, outputs.toxicNH3pH]);
  const status = outputs.uiaStatusLevel === 'safe' ? '✓ Safe' : outputs.uiaStatusLevel === 'alert' ? '⚠ Alert' : '✗ Danger';
  return (
    <ChartCard
      title="UIA-N (NH₃) vs pH"
      subtitle={`TAN=${inputs.tan} mg/L | NH₃=${outputs.currentUIA.toFixed(4)} mg/L (${percentNH3(inputs.pH, inputs.tempC, inputs.salinity).toFixed(2)}%) | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(2)} | ${status}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={uiaData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          {zones.safe && (
            <ReferenceArea x1={zones.safe.x1} x2={zones.safe.x2} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
          )}
          {zones.alert && (
            <ReferenceArea x1={zones.alert.x1} x2={zones.alert.x2} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
          )}
          {zones.danger && (
            <ReferenceArea x1={zones.danger.x1} x2={zones.danger.x2} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
          )}
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="pH" tick={{ fontSize: 11 }} type="number" domain={[6.0, 9.5]} />
          <YAxis
            domain={[0, inputs.unIonizedNH3 * 2.5]}
            allowDataOverflow={true}
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => (v < 0.001 ? v.toExponential(1) : v.toFixed(4))}
          />
          <Tooltip formatter={(value: number, name: string) => (name === 'NH₃ Limit' ? `${value.toFixed(4)} mg/L (limit)` : `${value.toFixed(4)} mg/L`)} />
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
          {zones.showCriticalLine && (
            <ReferenceLine x={outputs.toxicNH3pH} stroke="#ef4444" strokeWidth={2} label={{ value: `Crit ${outputs.toxicNH3pH.toFixed(1)}`, position: 'top', fontSize: 9, fill: '#ef4444' }} />
          )}
          <ReferenceLine y={inputs.unIonizedNH3} stroke="#f97316" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: 'Limit', position: 'right', fontSize: 9, fill: '#f97316' }} />
          <Line type="monotone" dataKey="UIA" name="UIA-N (NH₃)" stroke="#ef4444" strokeWidth={2.5} dot={false} />
          <Line type="monotone" dataKey="limit" name="NH₃ Limit" stroke="#f97316" strokeWidth={1} dot={false} strokeDasharray="4 4" />
          {intersectionPoints.map((pt, i) => (
            <ReferenceDot key={i} x={pt.pH} y={pt.UIA} r={6} fill={pt.color} stroke="#fff" strokeWidth={2} isFront={true} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function H2sVsPhChart({ inputs, outputs }: ChartProps): ReactElement {
  const h2sData = useMemo(
    () =>
      generateH2SvsPHData(
        inputs.tempC,
        inputs.salinity,
        inputs.h2sUgL,
        inputs.pH,
        inputs.h2sLimitUgL,
        DEFFEYES_CHART_PH_DOMAIN.minPH,
        DEFFEYES_CHART_PH_DOMAIN.maxPH,
      ),
    [inputs.tempC, inputs.salinity, inputs.h2sUgL, inputs.pH, inputs.h2sLimitUgL],
  );
  const zones = useMemo(
    () => getVisibleH2SChartZones(outputs.toxicH2SpH, DEFFEYES_CHART_PH_DOMAIN.minPH, DEFFEYES_CHART_PH_DOMAIN.maxPH),
    [outputs.toxicH2SpH],
  );
  const currentH2SPercent =
    outputs.totalSulfide > 0 && Number.isFinite(outputs.totalSulfide) ? (outputs.currentH2S / outputs.totalSulfide) * 100 : NaN;
  const status = outputs.h2sStatusLevel === 'safe' ? '✓ Safe' : outputs.h2sStatusLevel === 'alert' ? '⚠ Alert' : '✗ Danger';
  return (
    <ChartCard
      title="H₂S / HS⁻ vs pH"
      subtitle={`Current H₂S=${outputs.currentH2S.toFixed(1)} µg/L (${Number.isFinite(currentH2SPercent) ? currentH2SPercent.toFixed(1) : 'N/A'}%) | Measured=${inputs.h2sUgL} µg/L | Limit=${inputs.h2sLimitUgL} µg/L | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(2)} | ${status}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={h2sData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          {zones.danger && (
            <ReferenceArea x1={zones.danger.x1} x2={zones.danger.x2} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
          )}
          {zones.alert && (
            <ReferenceArea x1={zones.alert.x1} x2={zones.alert.x2} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
          )}
          {zones.safe && (
            <ReferenceArea x1={zones.safe.x1} x2={zones.safe.x2} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
          )}
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="pH" tick={{ fontSize: 11 }} type="number" domain={[DEFFEYES_CHART_PH_DOMAIN.minPH, DEFFEYES_CHART_PH_DOMAIN.maxPH]} />
          <YAxis domain={[0, 100]} allowDataOverflow={true} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip formatter={(value: number, name: string) => (name === 'H₂S µg/L' ? `${value.toFixed(2)} µg/L` : `${value.toFixed(1)}%`)} />
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
          {zones.showCriticalLine && (
            <ReferenceLine x={outputs.toxicH2SpH} stroke="#ef4444" strokeWidth={2} label={{ value: `Crit ${outputs.toxicH2SpH.toFixed(1)}`, position: 'top', fontSize: 9, fill: '#ef4444' }} />
          )}
          <Line type="monotone" dataKey="H2S_pct" name="H₂S %" stroke="#ef4444" strokeWidth={2.5} dot={false} />
          <Line type="monotone" dataKey="HS_pct" name="HS⁻ %" stroke="#06b6d4" strokeWidth={2} dot={false} />
          {Number.isFinite(currentH2SPercent) && (
            <ReferenceDot x={inputs.pH} y={currentH2SPercent} r={6} fill="#3b82f6" stroke="#fff" strokeWidth={2} isFront={true} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function CarbonateVsPhChart({ inputs, outputs }: ChartProps): ReactElement {
  const carbonateData = useMemo(
    () => generateCarbonateVsPHData(inputs.tempC, inputs.salinity, 2.0, DEFFEYES_LEGACY_PH_DOMAIN.minPH, DEFFEYES_LEGACY_PH_DOMAIN.maxPH),
    [inputs.tempC, inputs.salinity],
  );
  return (
    <ChartCard
      title="CO₂ / HCO₃⁻ / CO₃²⁻ vs pH"
      subtitle={`pH=${inputs.pH} | CO₂=${outputs.currentCO2.toFixed(1)} mg/L | Crit pH=${isNaN(outputs.toxicCO2pH) ? 'N/A' : outputs.toxicCO2pH.toFixed(2)} | Millero (T=${inputs.tempC}°C, S=${inputs.salinity} ppt)`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={carbonateData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="pH" tick={{ fontSize: 11 }} type="number" domain={[4, 12]} />
          <YAxis domain={[0, 1]} allowDataOverflow={true} tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
          <Tooltip formatter={(value: number) => `${(value * 100).toFixed(1)}%`} />
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
          <Line type="monotone" dataKey="CO2" name="CO₂" stroke="#f59e0b" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="HCO3" name="HCO₃⁻" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="CO3" name="CO₃²⁻" stroke="#8b5cf6" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function CalciteSaturationChart({ inputs }: ChartProps): ReactElement {
  const saturationData = useMemo(() => {
    const currentDic = calcDicOfAlk(alkMgToMeq(inputs.alkalinityMg), inputs.pH, inputs.tempC, inputs.salinity);
    return generateSaturationVsPHData(inputs.tempC, inputs.salinity, currentDic, inputs.caMgL);
  }, [inputs.alkalinityMg, inputs.pH, inputs.tempC, inputs.salinity, inputs.caMgL]);
  return (
    <ChartCard
      title="Calcite / Aragonite SI"
      subtitle={`Mucci 1983 (T=${inputs.tempC}°C, S=${inputs.salinity} ppt, Ca=${inputs.caMgL} mg/L)`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={saturationData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="pH" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value: number) => value.toFixed(2)} />
          <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
          <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="3 3" />
          <ReferenceLine x={inputs.pH} stroke="#94a3b8" strokeDasharray="5 5" />
          <Line type="monotone" dataKey="Calcite" name="Calcite" stroke="#2563eb" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="Aragonite" name="Aragonite" stroke="#d946ef" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
