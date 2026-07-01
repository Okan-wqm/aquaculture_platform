/**
 * Tank drill-down charts (P1, mock).
 *
 * Renders the per-tank chemistry from the tank's SELF-CONSISTENT resolved set (via
 * engine-adapter → engine, unchanged). Guarded on engineReady, so a scope with no
 * single self-consistent tuple shows a message instead of a garbage point.
 *
 * These are LEAN renderers of engine data (isolines + operating point; pH-domain
 * line charts) — NOT a fork of farm-module's 926-line DeffeyesChart. The full
 * zone-shaded chart is delivered by promoting DeffeyesChart to shared-ui in the
 * real phase; the mock validates the per-tank drill-down UX first.
 */
import {
  calcNH3,
  co2Level,
  criticalPHforCO2,
  criticalPHforNH3,
  generateCarbonateVsPHData,
  generateDeffeyesChartData,
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

import { toEngineInputs } from '../engine-adapter';
import type { ResolvedParameterSet } from '../types';

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactElement }): ReactElement {
  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-3 py-2">
        <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
      <div className="p-2" style={{ height: 260 }}>{children}</div>
    </div>
  );
}

const TankDrilldown = ({ set }: { set: ResolvedParameterSet }): ReactElement => {
  const inputs = useMemo(() => toEngineInputs(set), [set]);

  const charts = useMemo(() => {
    if (!inputs) return null;
    const { tempC, salinity, pH, alkalinityMeq, tan, nh3Limit, co2Toxic } = inputs;
    const deffeyes = generateDeffeyesChartData(
      { tempC, pH, salinity, alkalinity: alkalinityMeq },
      null,
      { tan, unIonizedNH3: nh3Limit, co2Toxic, h2sMeasuredUgL: inputs.h2sUgL, h2sLimitUgL: inputs.h2sLimitUgL, h2sMeasuredAtPH: pH },
      alkalinityMeq * 0.6,
      alkalinityMeq * 1.4,
      inputs.caMgL,
      false,
    );
    // every-0.5-pH subset of isolines for a legible lean chart
    const isolines = deffeyes.isolines.filter((iso) => Math.abs(iso.pH * 2 - Math.round(iso.pH * 2)) < 1e-6 && Number.isInteger(iso.pH * 2));
    return {
      isolines: isolines.length ? isolines : deffeyes.isolines,
      current: deffeyes.currentPoint,
      uia: generateUIAvsPHData(tempC, salinity, tan, nh3Limit),
      carbonate: generateCarbonateVsPHData(tempC, salinity),
      critNH3: criticalPHforNH3(tan, nh3Limit, tempC, salinity),
      critCO2: criticalPHforCO2(alkalinityMeq, co2Toxic, tempC, salinity),
      currentNH3: calcNH3(tan, pH, tempC, salinity),
      currentCO2: co2Level(alkalinityMeq, pH, tempC, salinity),
    };
  }, [inputs]);

  if (!inputs || !charts) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
        No self-consistent measurement set for this scope — pick a tank (a loop has no single pH).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <span>pH <b>{inputs.pH.toFixed(2)}</b></span>
        <span>CO₂ <b>{charts.currentCO2.toFixed(1)}</b> mg/L</span>
        <span>NH₃-N <b>{charts.currentNH3.toFixed(4)}</b> mg/L</span>
        <span className="text-gray-500">Toxic NH₃ pH {Number.isNaN(charts.critNH3) ? 'N/A' : charts.critNH3.toFixed(2)}</span>
        <span className="text-gray-500">Toxic CO₂ pH {Number.isNaN(charts.critCO2) ? 'N/A' : charts.critCO2.toFixed(2)}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card title="Deffeyes (ALK vs DIC)" subtitle={`T=${inputs.tempC}°C · S=${inputs.salinity} ppt · lean isolines + operating point`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis type="number" dataKey="CT" domain={[0, 8]} tick={{ fontSize: 10 }} label={{ value: 'DIC (mmol/L)', position: 'insideBottom', fontSize: 10, dy: 10 }} />
              <YAxis type="number" domain={[0, 8]} tick={{ fontSize: 10 }} label={{ value: 'ALK (meq/L)', angle: -90, position: 'insideLeft', fontSize: 10 }} />
              {charts.isolines.map((iso) => (
                <Line key={iso.pH} data={iso.points} dataKey="AT" stroke={iso.color} strokeWidth={0.8} dot={false} isAnimationActive={false} legendType="none" />
              ))}
              <ReferenceDot x={charts.current.DIC} y={charts.current.ALK} r={5} fill="#2563eb" stroke="#fff" strokeWidth={1.5} isFront />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="UIA-N (NH₃) vs pH" subtitle={`TAN=${inputs.tan} mg/L · limit ${inputs.nh3Limit} mg/L`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={charts.uia} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="pH" type="number" domain={[6, 9.5]} tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v.toFixed(3)} />
              <Tooltip formatter={(v: number) => `${v.toFixed(4)} mg/L`} />
              <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, fontSize: 9, fill: '#3b82f6', position: 'top' }} />
              {!Number.isNaN(charts.critNH3) && <ReferenceLine x={charts.critNH3} stroke="#ef4444" label={{ value: 'crit', fontSize: 9, fill: '#ef4444', position: 'top' }} />}
              <ReferenceLine y={inputs.nh3Limit} stroke="#f97316" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="UIA" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="CO₂ / HCO₃⁻ / CO₃²⁻ vs pH" subtitle={`Millero T=${inputs.tempC}°C · S=${inputs.salinity} ppt`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={charts.carbonate} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="pH" type="number" domain={[4, 12]} tick={{ fontSize: 10 }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
              <Tooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
              <Legend verticalAlign="top" height={22} wrapperStyle={{ fontSize: 10 }} />
              <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeDasharray="5 5" />
              <Line type="monotone" dataKey="CO2" name="CO₂" stroke="#f59e0b" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="HCO3" name="HCO₃⁻" stroke="#10b981" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="CO3" name="CO₃²⁻" stroke="#8b5cf6" strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-xs text-gray-500">
          Full zone-shaded Deffeyes + H₂S charts land when <code className="mx-1">DeffeyesChart</code> is promoted to shared-ui (real phase). This mock validates the per-tank drill-down UX + engine wiring.
        </div>
      </div>
    </div>
  );
};

export default TankDrilldown;
