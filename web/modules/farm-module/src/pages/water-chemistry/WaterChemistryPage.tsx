/**
 * Water Chemistry Page
 * Full-featured water chemistry calculator with Millero equations,
 * Deffeyes diagram, toxic zone analysis, and chemical dosing.
 *
 * Ported from Python v1.py PyQt5 application.
 */
import {
  buildDeffeyesData,
  computeWaterChemistryOutputs,
  getVisibleH2SChartZones,
  getVisibleNH3ChartZones,
  useCanMutate,
  type WaterChemistryInputs,
} from '@aquaculture/shared-ui';
import {
  alkMgToMeq,
  calcDicOfAlk,
  calcForwardDosing,
  DEFFEYES_CHART_PH_DOMAIN,
  DEFFEYES_LEGACY_PH_DOMAIN,
  generateCarbonateVsPHData,
  generateH2SvsPHData,
  generateSaturationVsPHData,
  generateUIAvsPHData,
  percentNH3,
  REAGENTS,
} from '@platform/aquaculture-engines';
import React, { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  ComposedChart,
  CartesianGrid,
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

// Component imports
import { BulkRecordTab } from './components/BulkRecordTab';
import DeffeyesChart from './components/DeffeyesChart';
import { HistoryTab } from './components/HistoryTab';
import InputPanel from './components/InputPanel';
import OnDemandPanel from './components/OnDemandPanel';
import { ParameterConfigManager } from './components/ParameterConfigManager';
import { RecordTab } from './components/RecordTab';
import ResultsPanel from './components/ResultsPanel';
import { reportWaterChemistryDiagnostic } from './waterChemistryDiagnostics';
import {
  buildWaterChemistryReportHtml,
  collectWaterChemistryReportCharts,
  printWaterChemistryReport,
} from './waterChemistryReportExport';
// ============================================================================
// CHART CARD WRAPPER
// ============================================================================

interface ChartCardProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

const ChartCard: React.FC<ChartCardProps> = ({ title, subtitle, children }) => (
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

// ============================================================================
// DEFAULT INPUT VALUES
// ============================================================================

const DEFAULT_INPUTS: WaterChemistryInputs = {
  tempC: 12,
  pH: 7.0,
  salinity: 1,
  alkalinityMg: 80,
  targetpH: 7.5,
  targetAlkalinityMg: 100,
  alkMinMg: 50,
  alkMaxMg: 100,
  tan: 0.5,
  unIonizedNH3: 0.0125,
  co2Toxic: 40,
  h2sUgL: 15,
  h2sLimitUgL: 25,
  caMgL: 400,
  volume: 1,
  fishType: 'Arctic Charr',
  fishSize: '0-5 gram',
  showTarget: true,
};

// ============================================================================
// OVERVIEW CONTENT - Upgraded with Millero engine
// ============================================================================

const OverviewContent: React.FC = () => {
  const [inputs, setInputs] = useState<WaterChemistryInputs>(DEFAULT_INPUTS);
  const [selectedReagents, setSelectedReagents] = useState<string[]>([
    'Sodium Bicarbonate',
    'Sodium Hydroxide',
    'Add CO₂',
    'De-gas CO₂',
  ]);
  const [onDemandAmounts, setOnDemandAmounts] = useState<Record<string, number>>({});

  // Convert inputs to engine parameters
  const alkMeq = alkMgToMeq(inputs.alkalinityMg);
  // H₂S is measured in-situ, so its measurement pH IS the single realtime pH —
  // the same pH that drives the CO₂ and NH₃ toxicity calcs. No separate knob.
  const h2sMeasuredAtPH = inputs.pH;

  // Deffeyes chart data + reagent visualization — shared SSoT builder (identical
  // logic for the farm calculator and the sensor-module cards).
  const deffeyesDataWithReagent = useMemo(
    () =>
      buildDeffeyesData(inputs, selectedReagents, {
        onError: (_stage, e) => reportWaterChemistryDiagnostic('deffeyes-data-generation', e),
      }),
    [inputs, selectedReagents],
  );

  // Generate UIA chart data (replaces old NH3 chart)
  const uiaData = useMemo(
    () => generateUIAvsPHData(inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3),
    [inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3]
  );

  const h2sData = useMemo(
    () => generateH2SvsPHData(
      inputs.tempC,
      inputs.salinity,
      inputs.h2sUgL,
      h2sMeasuredAtPH,
      inputs.h2sLimitUgL,
      DEFFEYES_CHART_PH_DOMAIN.minPH,
      DEFFEYES_CHART_PH_DOMAIN.maxPH
    ),
    [inputs.tempC, inputs.salinity, inputs.h2sUgL, h2sMeasuredAtPH, inputs.h2sLimitUgL]
  );
  const carbonateData = useMemo(
    () => generateCarbonateVsPHData(
      inputs.tempC,
      inputs.salinity,
      2.0,
      DEFFEYES_LEGACY_PH_DOMAIN.minPH,
      DEFFEYES_LEGACY_PH_DOMAIN.maxPH
    ),
    [inputs.tempC, inputs.salinity]
  );
  // DIC needed for saturation chart - compute from current alk & pH
  const currentDicForChart = useMemo(
    () => calcDicOfAlk(alkMeq, inputs.pH, inputs.tempC, inputs.salinity),
    [alkMeq, inputs.pH, inputs.tempC, inputs.salinity]
  );

  const saturationData = useMemo(
    () => generateSaturationVsPHData(inputs.tempC, inputs.salinity, currentDicForChart, inputs.caMgL),
    [inputs.tempC, inputs.salinity, currentDicForChart, inputs.caMgL]
  );

  // Calculate outputs — shared SSoT compute (identical numbers everywhere).
  const outputs = useMemo(
    () => computeWaterChemistryOutputs(inputs, selectedReagents),
    [inputs, selectedReagents],
  );

  // On-demand forward dosing path — derived from the amounts Record
  const onDemandPath = useMemo(() => {
    const activeInputs = REAGENTS
      .filter(r => (onDemandAmounts[r.name] || 0) > 0)
      .map(r => ({ reagentKey: r.name, amountGrams: onDemandAmounts[r.name] }));
    if (activeInputs.length === 0) return [];
    const currentDIC = calcDicOfAlk(alkMeq, inputs.pH, inputs.tempC, inputs.salinity);
    return calcForwardDosing(
      { dic: currentDIC, alk: alkMeq, tempC: inputs.tempC, salinity: inputs.salinity },
      inputs.volume,
      activeInputs,
    );
  }, [onDemandAmounts, alkMeq, inputs.pH, inputs.tempC, inputs.salinity, inputs.volume]);

  // Intersection points for UIA chart: current pH point + critical pH point
  const uiaIntersectionPoints = useMemo(() => {
    const points: Array<{ pH: number; UIA: number; label: string; color: string }> = [];
    points.push({
      pH: inputs.pH,
      UIA: outputs.currentUIA,
      label: 'Current',
      color: '#3b82f6',
    });
    if (!isNaN(outputs.toxicNH3pH)) {
      points.push({
        pH: outputs.toxicNH3pH,
        UIA: inputs.unIonizedNH3,
        label: 'Critical',
        color: '#ef4444',
      });
    }
    return points;
  }, [inputs.pH, outputs.currentUIA, outputs.toxicNH3pH, inputs.unIonizedNH3]);

  const h2sChartZones = useMemo(
    () => getVisibleH2SChartZones(
      outputs.toxicH2SpH,
      DEFFEYES_CHART_PH_DOMAIN.minPH,
      DEFFEYES_CHART_PH_DOMAIN.maxPH
    ),
    [outputs.toxicH2SpH]
  );
  // UIA chart is drawn over pH 6.0–9.5; clamp the NH₃ bands to that domain so
  // they never silently vanish when the critical pH falls outside it.
  const nh3ChartZones = useMemo(
    () => getVisibleNH3ChartZones(outputs.toxicNH3pH, 6.0, 9.5),
    [outputs.toxicNH3pH]
  );
  const currentH2SPercent = outputs.totalSulfide > 0 && Number.isFinite(outputs.totalSulfide)
    ? (outputs.currentH2S / outputs.totalSulfide) * 100
    : NaN;

  const chartAreaRef = React.useRef<HTMLDivElement>(null);
  const [forceReportSafetyOverlays, setForceReportSafetyOverlays] = useState(false);

  const handlePrint = (): void => {
    if (!chartAreaRef.current) return;

    const { charts, deffeyesChart } = collectWaterChemistryReportCharts(chartAreaRef.current);

    // Build parameters table
    const params = [
      ['Temperature', `${inputs.tempC} °C`, 'pH (Realtime)', `${inputs.pH} NBS`],
      ['Salinity', `${inputs.salinity} ppt`, 'Alkalinity', `${inputs.alkalinityMg} mg/L CaCO₃`],
      ['Target pH', `${inputs.targetpH} NBS`, 'Target Alkalinity', `${inputs.targetAlkalinityMg} mg/L CaCO₃`],
      ['TAN', `${inputs.tan} mg/L`, 'NH₃-N Limit', `${inputs.unIonizedNH3} mg/L`],
      ['CO₂ Toxic', `${inputs.co2Toxic} mg/L`, 'H₂S Measured', `${inputs.h2sUgL} µg/L`],
      ['H₂S Limit', `${inputs.h2sLimitUgL} µg/L`, 'Current H₂S', `${outputs.currentH2S.toFixed(1)} µg/L`],
      ['Ca²⁺', `${inputs.caMgL} mg/L`, 'Chart', 'ALK/DIC Deffeyes'],
      ['Fish Type', inputs.fishType, 'Fish Size', inputs.fishSize],
      ['Volume', `${inputs.volume} m³`, 'Alk Range', `${inputs.alkMinMg} - ${inputs.alkMaxMg} mg/L`],
    ];

    const resultsRows = [
      ['Toxic NH₃ pH Border', isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(3), 'Current NH₃-N', `${outputs.currentUIA.toFixed(4)} mg/L`],
      ['Toxic CO₂ pH Border', isNaN(outputs.toxicCO2pH) ? 'N/A' : outputs.toxicCO2pH.toFixed(3), 'Current CO₂', `${outputs.currentCO2.toFixed(2)} mg/L`],
      ['Toxic H₂S pH Border', isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(3), 'Total Sulfide', `${outputs.totalSulfide > 10000 ? '> 10000' : outputs.totalSulfide.toFixed(1)} µg/L`],
      ['UIA Status', outputs.uiaStatusLevel.toUpperCase(), 'H₂S Status', outputs.h2sStatusLevel.toUpperCase()],
      ['Current DIC', `${outputs.currentDIC.toFixed(3)} mmol/L`, 'Target DIC', `${outputs.targetDIC.toFixed(3)} mmol/L`],
    ];

    const result = printWaterChemistryReport(buildWaterChemistryReportHtml({
      generatedAt: new Date(),
      parameters: params,
      results: resultsRows,
      charts,
      deffeyesChart,
    }));
    if (result === 'unavailable') {
      reportWaterChemistryDiagnostic('report-print-fallback', result);
    }
  };

  const handlePrintClick = (): void => {
    flushSync(() => setForceReportSafetyOverlays(true));
    try {
      handlePrint();
    } finally {
      flushSync(() => setForceReportSafetyOverlays(false));
    }
  };

  return (
    <div className="space-y-2" ref={chartAreaRef}>
      {/* ROW 1: Horizontal Input Bar + Print button */}
      <InputPanel
        inputs={inputs}
        onChange={setInputs}
        selectedReagents={selectedReagents}
        onReagentsChange={setSelectedReagents}
        onDemandAmounts={onDemandAmounts}
        onDemandAmountsChange={setOnDemandAmounts}
      />

      {/* Print button */}
      <div className="flex justify-end">
        <button
          onClick={handlePrintClick}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
          </svg>
          Print Report
        </button>
      </div>

      {/* Dosing Simulator Results — appears between input and charts when active */}
      <OnDemandPanel
        steps={onDemandPath}
        co2ToxicMgL={inputs.co2Toxic}
      />

      {/* ROW 2: 3-Column Chart Layout - [UIA+H2S] | [Deffeyes] | [CO2+Calcite] */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.6fr_1fr] gap-4 items-stretch">
        {/* Left Column: UIA + H2S stacked */}
        <div className="space-y-4 flex flex-col">
          {/* UIA (Un-ionized Ammonia) vs pH - with safety zones */}
          <ChartCard
            title="UIA-N (NH₃) vs pH"
            subtitle={`TAN=${inputs.tan} mg/L | NH₃=${outputs.currentUIA.toFixed(4)} mg/L (${percentNH3(inputs.pH, inputs.tempC, inputs.salinity).toFixed(2)}%) | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(2)} | ${
              outputs.uiaStatusLevel === 'safe' ? '✓ Safe' :
              outputs.uiaStatusLevel === 'alert' ? '⚠ Alert' : '✗ Danger'
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={uiaData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                {/* Safety zones — NH₃ toxic at HIGH pH (right side); clamped to the
                    [6.0, 9.5] chart domain so shading never silently disappears. */}
                {nh3ChartZones.safe && (
                  <ReferenceArea x1={nh3ChartZones.safe.x1} x2={nh3ChartZones.safe.x2} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
                )}
                {nh3ChartZones.alert && (
                  <ReferenceArea x1={nh3ChartZones.alert.x1} x2={nh3ChartZones.alert.x2} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
                )}
                {nh3ChartZones.danger && (
                  <ReferenceArea x1={nh3ChartZones.danger.x1} x2={nh3ChartZones.danger.x2} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="pH" tick={{ fontSize: 11 }} type="number" domain={[6.0, 9.5]} />
                <YAxis
                  domain={[0, inputs.unIonizedNH3 * 2.5]}
                  allowDataOverflow={true}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => v < 0.001 ? v.toExponential(1) : v.toFixed(4)}
                />
                <Tooltip formatter={(value: number, name: string) =>
                  name === 'NH₃ Limit' ? `${value.toFixed(4)} mg/L (limit)` : `${value.toFixed(4)} mg/L`
                } />
                <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
                {nh3ChartZones.showCriticalLine && (
                  <ReferenceLine x={outputs.toxicNH3pH} stroke="#ef4444" strokeWidth={2} label={{ value: `Crit ${outputs.toxicNH3pH.toFixed(1)}`, position: 'top', fontSize: 9, fill: '#ef4444' }} />
                )}
                <ReferenceLine y={inputs.unIonizedNH3} stroke="#f97316" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: 'Limit', position: 'right', fontSize: 9, fill: '#f97316' }} />
                <Line type="monotone" dataKey="UIA" name="UIA-N (NH₃)" stroke="#ef4444" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="limit" name="NH₃ Limit" stroke="#f97316" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                {uiaIntersectionPoints.map((pt, i) => (
                  <ReferenceDot key={i} x={pt.pH} y={pt.UIA} r={6} fill={pt.color} stroke="#fff" strokeWidth={2} isFront={true} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* H2S / HS- percentage distribution vs pH */}
          <ChartCard
            title="H₂S / HS⁻ vs pH"
            subtitle={`Current H₂S=${outputs.currentH2S.toFixed(1)} µg/L (${Number.isFinite(currentH2SPercent) ? currentH2SPercent.toFixed(1) : 'N/A'}%) | Measured=${inputs.h2sUgL} µg/L | Limit=${inputs.h2sLimitUgL} µg/L | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(2)} | ${
              outputs.h2sStatusLevel === 'safe' ? '✓ Safe' :
              outputs.h2sStatusLevel === 'alert' ? '⚠ Alert' : '✗ Danger'
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={h2sData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                {/* Safety zones - H₂S is toxic at LOW pH (left side), always visible */}
                {h2sChartZones.danger && (
                  <ReferenceArea x1={h2sChartZones.danger.x1} x2={h2sChartZones.danger.x2} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
                )}
                {h2sChartZones.alert && (
                  <ReferenceArea x1={h2sChartZones.alert.x1} x2={h2sChartZones.alert.x2} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
                )}
                {h2sChartZones.safe && (
                  <ReferenceArea x1={h2sChartZones.safe.x1} x2={h2sChartZones.safe.x2} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="pH"
                  tick={{ fontSize: 11 }}
                  type="number"
                  domain={[DEFFEYES_CHART_PH_DOMAIN.minPH, DEFFEYES_CHART_PH_DOMAIN.maxPH]}
                />
                <YAxis domain={[0, 100]} allowDataOverflow={true} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip formatter={(value: number, name: string) =>
                  name === 'H₂S µg/L' ? `${value.toFixed(2)} µg/L` : `${value.toFixed(1)}%`
                } />
                <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
                {h2sChartZones.showCriticalLine && (
                  <ReferenceLine x={outputs.toxicH2SpH} stroke="#ef4444" strokeWidth={2} label={{ value: `Crit ${outputs.toxicH2SpH.toFixed(1)}`, position: 'top', fontSize: 9, fill: '#ef4444' }} />
                )}
                <Line type="monotone" dataKey="H2S_pct" name="H₂S %" stroke="#ef4444" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="HS_pct" name="HS⁻ %" stroke="#06b6d4" strokeWidth={2} dot={false} />
                {/* Current point */}
                {Number.isFinite(currentH2SPercent) && (
                  <ReferenceDot x={inputs.pH} y={currentH2SPercent} r={6} fill="#3b82f6" stroke="#fff" strokeWidth={2} isFront={true} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* Center Column: Deffeyes Diagram (bigger) */}
        <div className="space-y-2">
          <div data-report-chart-id="deffeyes">
            <DeffeyesChart
              data={deffeyesDataWithReagent}
              onDemandPath={onDemandPath.length > 1 ? onDemandPath : undefined}
              forceSafetyOverlays={forceReportSafetyOverlays}
            />
          </div>
          </div>

        {/* Right Column: CO2 + Calcite stacked */}
        <div className="space-y-4 flex flex-col">
          {/* CO2 / HCO3 / CO3 vs pH */}
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

          {/* Calcite / Aragonite vs pH */}
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
        </div>
      </div>

      {/* ROW 3: Results - UIA Status | Calculated Values | Dosing Recipes */}
      <ResultsPanel outputs={outputs} />


    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

type TabId = 'calculator' | 'record' | 'bulk' | 'history' | 'parameters';

const WaterChemistryPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const canBulk = useCanMutate('createBatchWaterQualityMeasurements');
  const activeTab: TabId = (tabParam === 'record') ? 'record'
    : (tabParam === 'bulk' && canBulk) ? 'bulk'
    : (tabParam === 'history') ? 'history'
    : (tabParam === 'parameters') ? 'parameters'
    : 'calculator';

  const handleTabChange = (tabId: TabId): void => {
    setSearchParams(prev => {
      prev.set('tab', tabId);
      return prev;
    });
  };

  const tabs: { id: TabId; name: string }[] = [
    { id: 'calculator', name: 'Calculator' },
    { id: 'record', name: 'Record' },
    ...(canBulk ? [{ id: 'bulk' as TabId, name: 'Bulk' }] : []),
    { id: 'history', name: 'History' },
    { id: 'parameters', name: 'Parameters' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="px-4 sm:px-6 py-6">
          <h1 className="text-2xl font-bold text-gray-900">Water Chemistry</h1>
          <p className="mt-1 text-sm text-gray-500">Calculator, analysis, and historical water quality data</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 sm:px-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">
        {activeTab === 'calculator' && <OverviewContent />}
        {activeTab === 'record' && <RecordTab />}
        {activeTab === 'bulk' && canBulk && <BulkRecordTab />}
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'parameters' && <ParameterConfigManager />}
      </div>
    </div>
  );
};

export default WaterChemistryPage;
