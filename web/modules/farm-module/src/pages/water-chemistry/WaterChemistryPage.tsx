/**
 * Water Chemistry Page
 * Full-featured water chemistry calculator with Millero equations,
 * Deffeyes diagram, toxic zone analysis, and chemical dosing.
 *
 * Ported from Python v1.py PyQt5 application.
 */
import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  ReferenceDot,
  ComposedChart,
} from 'recharts';
// Engine imports
import { alkMgToMeq, CalculatedOutputs } from './engine/types';
import { calcDicOfAlk, calcCo2OfDic, co2MmToMg } from './engine/water-quality';
import {
  generateH2SvsPHData, generateUIAvsPHData,
  criticalPHforNH3, percentNH3, calcNH3, calcSafeTAN, uiaStatus,
  criticalPHforH2S, calcH2S, calcTotalSulfide, calcSafeTotalSulfide, h2sStatus,
} from './engine/ammonia-calc';
import { criticalPHforCO2, generateCarbonateVsPHData, generateSaturationVsPHData } from './engine/co2-calc';
import { generateDeffeyesChartData } from './engine/deffeyes-data';
import { calculateDosingRecipes, reagentDirectionLine, calcDosingVisualization, REAGENTS, calcForwardDosing } from './engine/reagents';

// Component imports
import InputPanel, { WaterChemistryInputs } from './components/InputPanel';
import DeffeyesChart from './components/DeffeyesChart';
import ResultsPanel from './components/ResultsPanel';
import OnDemandPanel from './components/OnDemandPanel';
import { HistoryTab } from './components/HistoryTab';
import { RecordTab } from './components/RecordTab';
import { ParameterConfigManager } from './components/ParameterConfigManager';
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
  const targetAlkMeq = alkMgToMeq(inputs.targetAlkalinityMg);
  const alkMinMeq = alkMgToMeq(inputs.alkMinMg);
  const alkMaxMeq = alkMgToMeq(inputs.alkMaxMg);

  // Generate Deffeyes chart data
  const deffeyesData = useMemo(
    () => {
      try {
        return generateDeffeyesChartData(
          { tempC: inputs.tempC, pH: inputs.pH, salinity: inputs.salinity, alkalinity: alkMeq },
          inputs.showTarget ? { targetpH: inputs.targetpH, targetAlkalinity: targetAlkMeq } : null,
          { tan: inputs.tan, unIonizedNH3: inputs.unIonizedNH3, co2Toxic: inputs.co2Toxic, h2s: inputs.h2sUgL },
          alkMinMeq,
          alkMaxMeq,
          inputs.caMgL
        );
      } catch (e) {
        console.error('[WaterChemistry] Deffeyes data generation error:', e);
        return {
          isolines: [], nh3ToxicZone: null, co2ToxicZone: null,
          safeZone: null, currentPoint: { DIC: 0, ALK: 0 }, targetPoint: null,
          reagentLine: null, dosingVisualization: null, omegaCalcite: null, omegaAragonite: null,
        };
      }
    },
    [inputs.tempC, inputs.pH, inputs.salinity, alkMeq, inputs.targetpH, targetAlkMeq,
     inputs.tan, inputs.unIonizedNH3, inputs.co2Toxic, inputs.h2sUgL, alkMinMeq, alkMaxMeq, inputs.showTarget, inputs.caMgL]
  );

  // Add reagent visualization to Deffeyes chart
  const deffeyesDataWithReagent = useMemo(() => {
    const result = { ...deffeyesData };

    if (selectedReagents.length === 1) {
      // Single reagent: show direction line
      const reagent = REAGENTS.find(r => r.name === selectedReagents[0]);
      if (reagent) {
        result.reagentLine = reagentDirectionLine(
          deffeyesData.currentPoint.DIC,
          deffeyesData.currentPoint.ALK,
          reagent,
          8
        );
      }
    } else if (selectedReagents.length === 2) {
      // Two reagents: compute dosing visualization
      // If target exists, compute full path; otherwise just direction lines for wedge
      if (deffeyesData.targetPoint) {
        const viz = calcDosingVisualization(
          deffeyesData.currentPoint.DIC,
          deffeyesData.currentPoint.ALK,
          deffeyesData.targetPoint.DIC,
          deffeyesData.targetPoint.ALK,
          selectedReagents[0],
          selectedReagents[1],
        );
        result.dosingVisualization = viz;
      }

      // Always compute direction lines for wedge visualization (even without target)
      if (!result.dosingVisualization) {
        const r1 = REAGENTS.find(r => r.name === selectedReagents[0]);
        const r2 = REAGENTS.find(r => r.name === selectedReagents[1]);
        if (r1 && r2) {
          const line1 = reagentDirectionLine(deffeyesData.currentPoint.DIC, deffeyesData.currentPoint.ALK, r1, 8);
          const line2 = reagentDirectionLine(deffeyesData.currentPoint.DIC, deffeyesData.currentPoint.ALK, r2, 8);
          const REAGENT_COLORS: Record<string, string> = {
            'Sodium Bicarbonate': '#2563eb', 'Sodium Carbonate': '#7c3aed',
            'Sodium Hydroxide': '#059669', 'Calcium Carbonate': '#0891b2',
            'Calcium Hydroxide': '#65a30d', 'Calcium Oxide': '#ca8a04',
            'Add CO₂': '#ea580c', 'De-gas CO₂': '#dc2626', 'Muriatic Acid': '#be185d',
          };
          result.dosingVisualization = {
            reagentLine1: { points: line1, label: r1.formula, color: REAGENT_COLORS[r1.name] || '#6b7280' },
            reagentLine2: { points: line2, label: r2.formula, color: REAGENT_COLORS[r2.name] || '#6b7280' },
            step1Path: [], step2Path: [],
            intermediatePoint: { DIC: 0, ALK: 0 },
            step1Label: '', step2Label: '',
          };
        }
      }
    }

    return result;
  }, [deffeyesData, selectedReagents]);

  // Generate UIA chart data (replaces old NH3 chart)
  const uiaData = useMemo(
    () => generateUIAvsPHData(inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3),
    [inputs.tempC, inputs.salinity, inputs.tan, inputs.unIonizedNH3]
  );

  const h2sData = useMemo(
    () => generateH2SvsPHData(inputs.tempC, inputs.salinity, inputs.h2sUgL, inputs.pH, inputs.h2sLimitUgL, 4, 9),
    [inputs.tempC, inputs.salinity, inputs.h2sUgL, inputs.pH, inputs.h2sLimitUgL]
  );
  const carbonateData = useMemo(
    () => generateCarbonateVsPHData(inputs.tempC, inputs.salinity, 2.0, 4.0, 12.0),
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

  // Calculate outputs
  const outputs = useMemo((): CalculatedOutputs => {
    const toxicNH3pH = criticalPHforNH3(inputs.tan, inputs.unIonizedNH3, inputs.tempC, inputs.salinity);
    const toxicCO2pH = criticalPHforCO2(alkMeq, inputs.co2Toxic, inputs.tempC, inputs.salinity);
    const uiaNPercent = isNaN(toxicNH3pH) ? NaN : percentNH3(toxicNH3pH, inputs.tempC, inputs.salinity);

    const currentDIC = calcDicOfAlk(alkMeq, inputs.pH, inputs.tempC, inputs.salinity);
    const currentCO2mm = calcCo2OfDic(currentDIC, inputs.pH, inputs.tempC, inputs.salinity);
    const currentCO2 = co2MmToMg(currentCO2mm);

    const targetDIC = calcDicOfAlk(targetAlkMeq, inputs.targetpH, inputs.tempC, inputs.salinity);
    const targetCO2mm = calcCo2OfDic(targetDIC, inputs.targetpH, inputs.tempC, inputs.salinity);
    const targetCO2 = co2MmToMg(targetCO2mm);

    const dosingRecipes = calculateDosingRecipes(
      currentDIC, alkMeq, targetDIC, targetAlkMeq,
      inputs.volume, selectedReagents
    );

    // UIA safety calculations (from R Shiny UIA module)
    const currentUIA = calcNH3(inputs.tan, inputs.pH, inputs.tempC, inputs.salinity);
    const safeTAN = calcSafeTAN(inputs.pH, inputs.unIonizedNH3, inputs.tempC, inputs.salinity);
    const uiaStatusLevel = uiaStatus(inputs.pH, toxicNH3pH);
    const deltaPH = isNaN(toxicNH3pH) ? NaN : toxicNH3pH - inputs.pH;

    // H₂S safety calculations
    const toxicH2SpH = criticalPHforH2S(inputs.h2sUgL, inputs.pH, inputs.h2sLimitUgL, inputs.tempC, inputs.salinity);
    const currentH2S = inputs.h2sUgL;
    const totalSulfide = calcTotalSulfide(inputs.h2sUgL, inputs.pH, inputs.tempC, inputs.salinity);
    const safeTotalSulfide = calcSafeTotalSulfide(inputs.pH, inputs.h2sLimitUgL, inputs.tempC, inputs.salinity);
    const h2sStatusLevel = h2sStatus(inputs.pH, toxicH2SpH);
    const h2sDeltaPH = isNaN(toxicH2SpH) ? NaN : inputs.pH - toxicH2SpH; // positive = safe (above critical)

    return {
      toxicNH3pH,
      toxicCO2pH,
      uiaNPercent,
      targetCO2,
      currentCO2,
      currentDIC,
      targetDIC,
      dosingRecipes,
      currentUIA,
      safeTAN,
      uiaStatusLevel,
      deltaPH,
      toxicH2SpH,
      currentH2S,
      totalSulfide,
      safeTotalSulfide,
      h2sStatusLevel,
      h2sDeltaPH,
    };
  }, [inputs, alkMeq, targetAlkMeq, selectedReagents]);

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

  const chartAreaRef = React.useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    if (!chartAreaRef.current) return;

    // Clone all SVGs from chart area
    const svgs = chartAreaRef.current.querySelectorAll('svg.recharts-surface');
    const chartSVGs: string[] = [];
    const chartTitles: string[] = [];

    // Get chart card titles
    chartAreaRef.current.querySelectorAll('.bg-white.rounded-lg, .bg-white.rounded-xl').forEach((card) => {
      const title = card.querySelector('h3')?.textContent || '';
      const subtitle = card.querySelector('p')?.textContent || '';
      const svg = card.querySelector('svg.recharts-surface');
      if (svg && title) {
        chartTitles.push(`<div style="margin-bottom:2px"><strong style="font-size:11px">${title}</strong>${subtitle ? `<br><span style="font-size:9px;color:#666">${subtitle}</span>` : ''}</div>`);
        const clone = svg.cloneNode(true) as SVGElement;
        clone.setAttribute('width', '100%');
        clone.removeAttribute('height');
        chartSVGs.push(clone.outerHTML);
      }
    });

    // Build parameters table
    const params = [
      ['Temperature', `${inputs.tempC} °C`, 'pH (Realtime)', `${inputs.pH} NBS`],
      ['Salinity', `${inputs.salinity} ppt`, 'Alkalinity', `${inputs.alkalinityMg} mg/L CaCO₃`],
      ['Target pH', `${inputs.targetpH} NBS`, 'Target Alkalinity', `${inputs.targetAlkalinityMg} mg/L CaCO₃`],
      ['TAN', `${inputs.tan} mg/L`, 'NH₃-N Limit', `${inputs.unIonizedNH3} mg/L`],
      ['CO₂ Toxic', `${inputs.co2Toxic} mg/L`, 'H₂S', `${inputs.h2sUgL} µg/L`],
      ['H₂S Limit', `${inputs.h2sLimitUgL} µg/L`, 'Ca²⁺', `${inputs.caMgL} mg/L`],
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

    const makeTable = (rows: string[][], title: string) => `
      <div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:bold;margin-bottom:3px;border-bottom:1px solid #333;padding-bottom:2px">${title}</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px">
          ${rows.map(r => `<tr>${r.map((c, i) => `<td style="padding:2px 6px;border:1px solid #ddd;${i % 2 === 0 ? 'background:#f9fafb;font-weight:500;width:18%' : 'width:32%'}">${c}</td>`).join('')}</tr>`).join('')}
        </table>
      </div>`;

    // Deffeyes chart is larger (center)
    const deffeyesSvg = chartSVGs[2] || ''; // 3rd chart is Deffeyes (index: UIA=0, H2S=1, Deffeyes=2, CO2=3, Calcite=4)
    const deffeyesTitle = chartTitles[2] || '';

    const win = window.open('', '_blank', 'width=1100,height=800');
    if (!win) return;

    win.document.write(`<!DOCTYPE html><html><head><title>Water Chemistry Report</title>
    <style>
      @page { size: A4 landscape; margin: 8mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 10px; color: #111; }
      .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 4px; margin-bottom: 6px; }
      .header h1 { font-size: 16px; }
      .header .date { font-size: 10px; color: #666; }
      .content { display: grid; grid-template-columns: 1fr 1.5fr 1fr; gap: 6px; }
      .chart-box { border: 1px solid #ddd; border-radius: 4px; padding: 4px; overflow: hidden; }
      .chart-box svg { width: 100%; display: block; }
      .side-charts { display: flex; flex-direction: column; gap: 6px; }
      .tables { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
      @media print {
        body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
    </style></head><body>
      <div class="header">
        <div><h1>Water Chemistry Report</h1><div class="date">${new Date().toLocaleString()}</div></div>
        <div style="text-align:right;font-size:9px;color:#444">Millero Equations | Mucci 1983 Ksp</div>
      </div>
      <div class="tables">${makeTable(params, 'Parameters')}${makeTable(resultsRows, 'Calculated Results')}</div>
      <div class="content" style="margin-top:6px">
        <div class="side-charts">
          <div class="chart-box">${chartTitles[0] || ''}${chartSVGs[0] || ''}</div>
          <div class="chart-box">${chartTitles[1] || ''}${chartSVGs[1] || ''}</div>
        </div>
        <div class="chart-box">${deffeyesTitle}${deffeyesSvg}</div>
        <div class="side-charts">
          <div class="chart-box">${chartTitles[3] || ''}${chartSVGs[3] || ''}</div>
          <div class="chart-box">${chartTitles[4] || ''}${chartSVGs[4] || ''}</div>
        </div>
      </div>
    </body></html>`);

    win.document.close();
    setTimeout(() => { win.print(); }, 500);
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
          onClick={handlePrint}
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
                {/* Safety zones - NH3 is toxic at HIGH pH (right side), always visible */}
                {!isNaN(outputs.toxicNH3pH) ? (
                  <>
                    <ReferenceArea x1={6.0} x2={outputs.toxicNH3pH - 0.2} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
                    <ReferenceArea x1={outputs.toxicNH3pH - 0.2} x2={outputs.toxicNH3pH} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
                    <ReferenceArea x1={outputs.toxicNH3pH} x2={9.5} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
                  </>
                ) : (
                  <ReferenceArea x1={6.0} x2={9.5} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
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
                {!isNaN(outputs.toxicNH3pH) && (
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
            subtitle={`H₂S=${inputs.h2sUgL} µg/L (${(h2sData.find(d => Math.abs(d.pH - inputs.pH) < 0.06)?.H2S_pct ?? 0).toFixed(1)}%) | Limit=${inputs.h2sLimitUgL} µg/L | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(2)} | ${
              outputs.h2sStatusLevel === 'safe' ? '✓ Safe' :
              outputs.h2sStatusLevel === 'alert' ? '⚠ Alert' : '✗ Danger'
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={h2sData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                {/* Safety zones - H₂S is toxic at LOW pH (left side), always visible */}
                {!isNaN(outputs.toxicH2SpH) ? (
                  <>
                    <ReferenceArea x1={4} x2={outputs.toxicH2SpH} fill="#ef4444" fillOpacity={0.15} label={{ value: 'Danger', fontSize: 9, fill: '#dc2626', position: 'insideTopLeft' }} />
                    <ReferenceArea x1={outputs.toxicH2SpH} x2={outputs.toxicH2SpH + 0.2} fill="#eab308" fillOpacity={0.2} label={{ value: 'Alert', fontSize: 9, fill: '#a16207', position: 'insideTopLeft' }} />
                    <ReferenceArea x1={outputs.toxicH2SpH + 0.2} x2={9} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
                  </>
                ) : (
                  <ReferenceArea x1={4} x2={9} fill="#22c55e" fillOpacity={0.18} label={{ value: 'Safe', fontSize: 9, fill: '#16a34a', position: 'insideTopLeft' }} />
                )}
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="pH" tick={{ fontSize: 11 }} type="number" domain={[4, 9]} />
                <YAxis domain={[0, 100]} allowDataOverflow={true} tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip formatter={(value: number, name: string) =>
                  name === 'H₂S µg/L' ? `${value.toFixed(2)} µg/L` : `${value.toFixed(1)}%`
                } />
                <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine x={inputs.pH} stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" label={{ value: `pH ${inputs.pH}`, position: 'top', fontSize: 9, fill: '#3b82f6' }} />
                {!isNaN(outputs.toxicH2SpH) && (
                  <ReferenceLine x={outputs.toxicH2SpH} stroke="#ef4444" strokeWidth={2} label={{ value: `Crit ${outputs.toxicH2SpH.toFixed(1)}`, position: 'top', fontSize: 9, fill: '#ef4444' }} />
                )}
                <Line type="monotone" dataKey="H2S_pct" name="H₂S %" stroke="#ef4444" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="HS_pct" name="HS⁻ %" stroke="#06b6d4" strokeWidth={2} dot={false} />
                {/* Current point */}
                <ReferenceDot x={inputs.pH} y={h2sData.find(d => Math.abs(d.pH - inputs.pH) < 0.06)?.H2S_pct ?? 0} r={6} fill="#3b82f6" stroke="#fff" strokeWidth={2} isFront={true} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* Center Column: Deffeyes Diagram (bigger) */}
        <DeffeyesChart data={deffeyesDataWithReagent} onDemandPath={onDemandPath.length > 1 ? onDemandPath : undefined} />

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

type TabId = 'calculator' | 'record' | 'history' | 'parameters';

const WaterChemistryPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = (tabParam === 'record') ? 'record'
    : (tabParam === 'history') ? 'history'
    : (tabParam === 'parameters') ? 'parameters'
    : 'calculator';

  const handleTabChange = (tabId: TabId) => {
    setSearchParams(prev => {
      prev.set('tab', tabId);
      return prev;
    });
  };

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
            {[
              { id: 'calculator' as TabId, name: 'Calculator' },
              { id: 'record' as TabId, name: 'Record' },
              { id: 'history' as TabId, name: 'History' },
              { id: 'parameters' as TabId, name: 'Parameters' },
            ].map((tab) => (
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
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'parameters' && <ParameterConfigManager />}
      </div>
    </div>
  );
};

export default WaterChemistryPage;
