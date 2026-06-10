/**
 * Water Chemistry Page
 * Full-featured water chemistry calculator with Millero equations,
 * Deffeyes diagram, toxic zone analysis, and chemical dosing.
 *
 * Ported from Python v1.py PyQt5 application.
 */
import { useCanMutate } from '@aquaculture/shared-ui';
import {
  alkMgToMeq,
  CalculatedOutputs,
  calcCo2OfDic,
  calcDicOfAlk,
  calcDosingVisualization,
  calcForwardDosing,
  calcH2S,
  calcNH3,
  calcSafeTAN,
  calcSafeTotalSulfide,
  calcTotalSulfide,
  calculateDosingRecipes,
  co2MmToMg,
  criticalPHforCO2,
  criticalPHforH2SPHChartDomain,
  criticalPHforNH3,
  DEFFEYES_CHART_MAX_DIC,
  DEFFEYES_CHART_PH_DOMAIN,
  DEFFEYES_LEGACY_PH_DOMAIN,
  generateCarbonateVsPHData,
  generateDeffeyesChartData,
  generateDeffeyesPHChartData,
  generateH2SvsPHData,
  generateSaturationVsPHData,
  generateUIAvsPHData,
  h2sStatus,
  percentNH3,
  projectAlkDicLineWithStats,
  projectAlkDicPointToDicPh,
  REAGENTS,
  reagentDirectionLine,
  uiaStatus,
} from '@platform/aquaculture-engines';
import type { DeffeyesPHChartData, DicPhSegment, ProjectionLayerStats } from '@platform/aquaculture-engines';
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
import DeffeyesPhChart from './components/DeffeyesPhChart';
import { HistoryTab } from './components/HistoryTab';
import InputPanel from './components/InputPanel';
import type { WaterChemistryInputs } from './components/InputPanel';
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
  h2sMeasuredAtPH: 7.0,
  h2sLimitUgL: 25,
  caMgL: 400,
  volume: 1,
  fishType: 'Arctic Charr',
  fishSize: '0-5 gram',
  showTarget: true,
};

const REAGENT_COLORS: Record<string, string> = {
  'Sodium Bicarbonate': '#2563eb',
  'Sodium Carbonate': '#7c3aed',
  'Sodium Hydroxide': '#059669',
  'Calcium Carbonate': '#0891b2',
  'Calcium Hydroxide': '#65a30d',
  'Calcium Oxide': '#ca8a04',
  'Add CO₂': '#ea580c',
  'De-gas CO₂': '#dc2626',
  'Muriatic Acid': '#be185d',
};

interface VisiblePHZone {
  x1: number;
  x2: number;
}

export function getVisibleH2SChartZones(
  criticalPH: number,
  minPH = DEFFEYES_CHART_PH_DOMAIN.minPH,
  maxPH = DEFFEYES_CHART_PH_DOMAIN.maxPH
): { danger?: VisiblePHZone; alert?: VisiblePHZone; safe?: VisiblePHZone; showCriticalLine: boolean } {
  if (!isFinite(criticalPH)) {
    return { safe: { x1: minPH, x2: maxPH }, showCriticalLine: false };
  }
  if (criticalPH < minPH) {
    return { safe: { x1: minPH, x2: maxPH }, showCriticalLine: false };
  }
  if (criticalPH >= maxPH) {
    return { danger: { x1: minPH, x2: maxPH }, showCriticalLine: criticalPH === maxPH };
  }

  const alertEnd = Math.min(maxPH, criticalPH + 0.2);
  return {
    danger: { x1: minPH, x2: criticalPH },
    alert: alertEnd > criticalPH ? { x1: criticalPH, x2: alertEnd } : undefined,
    safe: alertEnd < maxPH ? { x1: alertEnd, x2: maxPH } : undefined,
    showCriticalLine: true,
  };
}

type DeffeyesMode = 'ph' | 'legacy';
type ConfiguredDeffeyesMode = DeffeyesMode | 'invalid';

function normalizeConfiguredDeffeyesMode(mode: string | null | undefined): ConfiguredDeffeyesMode {
  const normalized = (mode ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'ph') return 'ph';
  if (normalized === 'legacy') return 'legacy';
  return 'invalid';
}

function normalizeDeffeyesModeOverride(mode: string | null | undefined): DeffeyesMode | null {
  const normalized = mode?.trim().toLowerCase() ?? '';
  if (normalized === 'ph' || normalized === 'legacy') return normalized;
  return null;
}

function resolveH2SMeasuredAtPH(inputPH: number | undefined, realtimePH: number): number {
  if (
    inputPH != null &&
    Number.isFinite(inputPH) &&
    inputPH >= DEFFEYES_CHART_PH_DOMAIN.minPH &&
    inputPH <= DEFFEYES_CHART_PH_DOMAIN.maxPH
  ) {
    return inputPH;
  }
  return realtimePH;
}

function createFallbackDeffeyesPHData(): DeffeyesPHChartData {
  return {
    domain: {
      maxDIC: DEFFEYES_CHART_MAX_DIC,
      minPH: DEFFEYES_CHART_PH_DOMAIN.minPH,
      maxPH: DEFFEYES_CHART_PH_DOMAIN.maxPH,
    },
    pHReferences: [],
    alkalinityLines: [],
    nh3ToxicZone: null,
    co2ToxicZone: null,
    h2sToxicZone: null,
    safeBands: [],
    currentPoint: { CT: 0, pH: 7, AT: 0 },
    targetPoint: null,
    targetPath: [],
    reagentLine: null,
    dosingVisualization: null,
    omegaCalcite: null,
    omegaAragonite: null,
    reagentLineSegments: [],
    projectionStats: { projected: 0, rejected: 0, clipped: 0, segments: 0, toxicSegments: 0, layers: {} },
  };
}

export function shouldUseLegacyDeffeyesChart(
  configuredMode: string | null | undefined,
  modeOverride: string | null | undefined,
  hasPHGenerationError = false,
  allowDiagnosticOverride = false
): boolean {
  if (hasPHGenerationError) return true;

  const normalizedConfiguredMode = normalizeConfiguredDeffeyesMode(configuredMode);
  const normalizedOverride = normalizeDeffeyesModeOverride(modeOverride);
  if (normalizedOverride === 'legacy') return true;
  if (normalizedConfiguredMode === 'invalid') return true;
  if (normalizedConfiguredMode === 'legacy') {
    return normalizedOverride !== 'ph' || !allowDiagnosticOverride;
  }
  return false;
}

function readViteEnv(name: string): string | undefined {
  const meta = import.meta as unknown as { env?: Record<string, unknown> };
  const value: unknown = meta.env?.[name];
  return typeof value === 'string' ? value : undefined;
}

function emptyProjectionLayerStats(): ProjectionLayerStats {
  return { projected: 0, rejected: 0, clipped: 0, segments: 0 };
}

function mergeProjectionLayerStats(layers: ProjectionLayerStats[]): ProjectionLayerStats {
  return layers.reduce((sum, layer) => ({
    projected: sum.projected + layer.projected,
    rejected: sum.rejected + layer.rejected,
    clipped: sum.clipped + layer.clipped,
    segments: sum.segments + layer.segments,
  }), emptyProjectionLayerStats());
}

function applyProjectionLayerStats(
  data: DeffeyesPHChartData,
  layers: Record<string, ProjectionLayerStats>
): DeffeyesPHChartData {
  const extra = mergeProjectionLayerStats(Object.values(layers));
  return {
    ...data,
    projectionStats: {
      ...data.projectionStats,
      projected: data.projectionStats.projected + extra.projected,
      rejected: data.projectionStats.rejected + extra.rejected,
      clipped: data.projectionStats.clipped + extra.clipped,
      segments: data.projectionStats.segments + extra.segments,
      layers: {
        ...data.projectionStats.layers,
        ...layers,
      },
    },
  };
}

function projectionDiagnosticsText(stats: ProjectionLayerStats): string {
  return `Projected ${stats.projected}; clipped ${stats.clipped}; rejected ${stats.rejected}; segments ${stats.segments}`;
}

function projectionWarningText(stats: ProjectionLayerStats): string | null {
  if (stats.clipped + stats.rejected === 0) return null;
  return `DIC/pH projection clipped ${stats.clipped} and rejected ${stats.rejected} point${stats.clipped + stats.rejected === 1 ? '' : 's'} outside the visible pH domain.`;
}

function sampleAlkDicSegmentWithStats(
  start: { CT: number; AT: number },
  end: { CT: number; AT: number },
  tempC: number,
  salinity: number,
  steps: number
): ReturnType<typeof projectAlkDicLineWithStats> {
  const samples = Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return {
      CT: start.CT + (end.CT - start.CT) * t,
      AT: start.AT + (end.AT - start.AT) * t,
    };
  });

  return projectAlkDicLineWithStats(samples, tempC, salinity);
}

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
  const h2sMeasuredAtPH = resolveH2SMeasuredAtPH(inputs.h2sMeasuredAtPH, inputs.pH);
  const configuredDeffeyesMode = readViteEnv('VITE_DEFFEYES_CHART_MODE');
  const allowDeffeyesDiagnosticOverride = (readViteEnv('VITE_DEFFEYES_ALLOW_DIAGNOSTIC_MODE_OVERRIDE') ?? '').toLowerCase() === 'true';
  const deffeyesModeOverride = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('deffeyesMode');
  const deffeyesRollbackRequested = shouldUseLegacyDeffeyesChart(
    configuredDeffeyesMode,
    deffeyesModeOverride,
    false,
    allowDeffeyesDiagnosticOverride
  );

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
        reportWaterChemistryDiagnostic('deffeyes-data-generation', e);
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

  const deffeyesPHResult = useMemo(
    () => {
      if (deffeyesRollbackRequested) {
        return { data: null, error: null };
      }

      try {
        return {
          data: generateDeffeyesPHChartData(
          { tempC: inputs.tempC, pH: inputs.pH, salinity: inputs.salinity, alkalinity: alkMeq },
          inputs.showTarget ? { targetpH: inputs.targetpH, targetAlkalinity: targetAlkMeq } : null,
          {
            tanMgL: inputs.tan,
            unIonizedNH3MgL: inputs.unIonizedNH3,
            co2ToxicMgL: inputs.co2Toxic,
            h2sMeasuredUgL: inputs.h2sUgL,
            h2sLimitUgL: inputs.h2sLimitUgL,
            h2sMeasuredAtPH,
          },
          alkMinMeq,
          alkMaxMeq,
          inputs.caMgL
          ),
          error: null,
        };
      } catch (e) {
        reportWaterChemistryDiagnostic('deffeyes-ph-data-generation', e);
        return { data: null, error: e };
      }
    },
    [inputs.tempC, inputs.pH, inputs.salinity, alkMeq, inputs.targetpH, targetAlkMeq,
     inputs.tan, inputs.unIonizedNH3, inputs.co2Toxic, inputs.h2sUgL, inputs.h2sLimitUgL,
     h2sMeasuredAtPH, alkMinMeq, alkMaxMeq, inputs.showTarget, inputs.caMgL, deffeyesRollbackRequested]
  );
  const deffeyesPHData = deffeyesPHResult.data ?? createFallbackDeffeyesPHData();
  const deffeyesPHError = deffeyesPHResult.error;
  const useLegacyDeffeyes = shouldUseLegacyDeffeyesChart(
    configuredDeffeyesMode,
    deffeyesModeOverride,
    deffeyesPHError != null,
    allowDeffeyesDiagnosticOverride
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

  const deffeyesPHDataWithReagent = useMemo((): DeffeyesPHChartData => {
    if (useLegacyDeffeyes) {
      return deffeyesPHData;
    }

    const result: DeffeyesPHChartData = { ...deffeyesPHData };
    const projectionLayers: Record<string, ProjectionLayerStats> = {};

    if (selectedReagents.length === 1) {
      const reagentName = selectedReagents[0];
      const reagent = reagentName ? REAGENTS.find(r => r.name === reagentName) : undefined;
      if (reagent) {
        const line = reagentDirectionLine(
          deffeyesData.currentPoint.DIC,
          deffeyesData.currentPoint.ALK,
          reagent,
          8
        );
        const projection = projectAlkDicLineWithStats(line, inputs.tempC, inputs.salinity, {
          truncateOnInvalid: true,
        });
        result.reagentLineSegments = projection.segments;
        result.reagentLine = projection.points;
        projectionLayers.reagentLine = projection.stats;
      }
    } else if (selectedReagents.length === 2) {
      const reagent1Name = selectedReagents[0];
      const reagent2Name = selectedReagents[1];
      if (!reagent1Name || !reagent2Name) return result;

      const viz = deffeyesData.targetPoint
        ? calcDosingVisualization(
            deffeyesData.currentPoint.DIC,
            deffeyesData.currentPoint.ALK,
            deffeyesData.targetPoint.DIC,
            deffeyesData.targetPoint.ALK,
            reagent1Name,
            reagent2Name,
          )
        : null;

      if (viz) {
        const step1Start = viz.step1Path[0];
        const step1End = viz.step1Path[1];
        const step2Start = viz.step2Path[0];
        const step2End = viz.step2Path[1];
        const reagentLine1Projection = projectAlkDicLineWithStats(viz.reagentLine1.points, inputs.tempC, inputs.salinity, {
          truncateOnInvalid: true,
        });
        const reagentLine2Projection = projectAlkDicLineWithStats(viz.reagentLine2.points, inputs.tempC, inputs.salinity, {
          truncateOnInvalid: true,
        });
        const step1PathProjection = step1Start && step1End
          ? sampleAlkDicSegmentWithStats(step1Start, step1End, inputs.tempC, inputs.salinity, 32)
          : { points: [], segments: [], stats: emptyProjectionLayerStats() };
        const step2PathProjection = step2Start && step2End
          ? sampleAlkDicSegmentWithStats(step2Start, step2End, inputs.tempC, inputs.salinity, 32)
          : { points: [], segments: [], stats: emptyProjectionLayerStats() };

        result.dosingVisualization = {
          reagentLine1: {
            ...viz.reagentLine1,
            points: reagentLine1Projection.points,
          },
          reagentLine2: {
            ...viz.reagentLine2,
            points: reagentLine2Projection.points,
          },
          reagentLine1Segments: reagentLine1Projection.segments,
          reagentLine2Segments: reagentLine2Projection.segments,
          step1Path: step1PathProjection.points,
          step2Path: step2PathProjection.points,
          step1PathSegments: step1PathProjection.segments,
          step2PathSegments: step2PathProjection.segments,
          intermediatePoint: projectAlkDicPointToDicPh(
            { CT: viz.intermediatePoint.DIC, AT: viz.intermediatePoint.ALK },
            inputs.tempC,
            inputs.salinity
          ),
          step1Label: viz.step1Label,
          step2Label: viz.step2Label,
        };
        projectionLayers.reagentLine1 = reagentLine1Projection.stats;
        projectionLayers.reagentLine2 = reagentLine2Projection.stats;
        projectionLayers.dosingStep1 = step1PathProjection.stats;
        projectionLayers.dosingStep2 = step2PathProjection.stats;
      } else {
        const r1 = REAGENTS.find(r => r.name === reagent1Name);
        const r2 = REAGENTS.find(r => r.name === reagent2Name);
        if (r1 && r2) {
          const line1 = reagentDirectionLine(deffeyesData.currentPoint.DIC, deffeyesData.currentPoint.ALK, r1, 8);
          const line2 = reagentDirectionLine(deffeyesData.currentPoint.DIC, deffeyesData.currentPoint.ALK, r2, 8);
          const line1Projection = projectAlkDicLineWithStats(line1, inputs.tempC, inputs.salinity, { truncateOnInvalid: true });
          const line2Projection = projectAlkDicLineWithStats(line2, inputs.tempC, inputs.salinity, { truncateOnInvalid: true });
          result.dosingVisualization = {
            reagentLine1: {
              points: line1Projection.points,
              label: r1.formula,
              color: REAGENT_COLORS[r1.name] || '#6b7280',
            },
            reagentLine2: {
              points: line2Projection.points,
              label: r2.formula,
              color: REAGENT_COLORS[r2.name] || '#6b7280',
            },
            reagentLine1Segments: line1Projection.segments,
            reagentLine2Segments: line2Projection.segments,
            step1Path: [],
            step2Path: [],
            intermediatePoint: null,
            step1Label: '',
            step2Label: '',
          };
          projectionLayers.reagentLine1 = line1Projection.stats;
          projectionLayers.reagentLine2 = line2Projection.stats;
        }
      }
    }

    return Object.keys(projectionLayers).length > 0
      ? applyProjectionLayerStats(result, projectionLayers)
      : result;
  }, [deffeyesPHData, deffeyesData, selectedReagents, inputs.tempC, inputs.salinity, useLegacyDeffeyes]);

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
    const toxicH2SpH = criticalPHforH2SPHChartDomain(
      inputs.h2sUgL,
      h2sMeasuredAtPH,
      inputs.h2sLimitUgL,
      inputs.tempC,
      inputs.salinity,
      DEFFEYES_CHART_PH_DOMAIN.minPH,
      DEFFEYES_CHART_PH_DOMAIN.maxPH
    );
    const totalSulfide = calcTotalSulfide(inputs.h2sUgL, h2sMeasuredAtPH, inputs.tempC, inputs.salinity);
    const currentH2S = calcH2S(totalSulfide, inputs.pH, inputs.tempC, inputs.salinity);
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
  }, [inputs, alkMeq, targetAlkMeq, selectedReagents, h2sMeasuredAtPH]);

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

  const onDemandChartProjection = useMemo((): { segments: DicPhSegment[]; stats: ProjectionLayerStats } => {
    if (useLegacyDeffeyes) return { segments: [], stats: emptyProjectionLayerStats() };
    if (onDemandPath.length < 2) return { segments: [], stats: emptyProjectionLayerStats() };

    const segments: DicPhSegment[] = [];
    const stats: ProjectionLayerStats[] = [];
    for (let i = 0; i < onDemandPath.length - 1; i++) {
      const step = onDemandPath[i];
      const next = onDemandPath[i + 1];
      if (!step || !next) continue;

      const projection = sampleAlkDicSegmentWithStats(
        { CT: step.dic, AT: step.alk },
        { CT: next.dic, AT: next.alk },
        inputs.tempC,
        inputs.salinity,
        24
      );
      segments.push(...projection.segments);
      stats.push(projection.stats);
    }

    return { segments, stats: mergeProjectionLayerStats(stats) };
  }, [onDemandPath, inputs.tempC, inputs.salinity, useLegacyDeffeyes]);
  const onDemandChartSegments = onDemandChartProjection.segments;
  const onDemandChartPath = useMemo(() => onDemandChartSegments.flat(), [onDemandChartSegments]);
  const dicPhProjectionStats = useMemo(
    () => useLegacyDeffeyes
      ? emptyProjectionLayerStats()
      : mergeProjectionLayerStats([
          deffeyesPHDataWithReagent.projectionStats,
          onDemandChartProjection.stats,
        ]),
    [deffeyesPHDataWithReagent.projectionStats, onDemandChartProjection.stats, useLegacyDeffeyes]
  );
  const dicPhProjectionWarning = useMemo(
    () => useLegacyDeffeyes ? null : projectionWarningText(dicPhProjectionStats),
    [dicPhProjectionStats, useLegacyDeffeyes]
  );

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
      ['CO₂ Toxic', `${inputs.co2Toxic} mg/L`, 'H₂S Measured', `${inputs.h2sUgL} µg/L @ pH ${h2sMeasuredAtPH}`],
      ['H₂S Limit', `${inputs.h2sLimitUgL} µg/L`, 'Current H₂S', `${outputs.currentH2S.toFixed(1)} µg/L`],
      ['Ca²⁺', `${inputs.caMgL} mg/L`, 'DIC/pH Mode', useLegacyDeffeyes ? 'Legacy ALK/DIC' : 'DIC/pH'],
      ['Fish Type', inputs.fishType, 'Fish Size', inputs.fishSize],
      ['Volume', `${inputs.volume} m³`, 'Alk Range', `${inputs.alkMinMg} - ${inputs.alkMaxMg} mg/L`],
    ];

    const resultsRows = [
      ['Toxic NH₃ pH Border', isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(3), 'Current NH₃-N', `${outputs.currentUIA.toFixed(4)} mg/L`],
      ['Toxic CO₂ pH Border', isNaN(outputs.toxicCO2pH) ? 'N/A' : outputs.toxicCO2pH.toFixed(3), 'Current CO₂', `${outputs.currentCO2.toFixed(2)} mg/L`],
      ['Toxic H₂S pH Border', isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(3), 'Total Sulfide', `${outputs.totalSulfide > 10000 ? '> 10000' : outputs.totalSulfide.toFixed(1)} µg/L`],
      ['UIA Status', outputs.uiaStatusLevel.toUpperCase(), 'H₂S Status', outputs.h2sStatusLevel.toUpperCase()],
      ['Current DIC', `${outputs.currentDIC.toFixed(3)} mmol/L`, 'Target DIC', `${outputs.targetDIC.toFixed(3)} mmol/L`],
      ...(useLegacyDeffeyes ? [] : [
        ['DIC/pH Projection Diagnostics', projectionDiagnosticsText(dicPhProjectionStats), 'Projection Warning', dicPhProjectionWarning ?? 'None'],
      ]),
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
            subtitle={`Current H₂S=${outputs.currentH2S.toFixed(1)} µg/L (${Number.isFinite(currentH2SPercent) ? currentH2SPercent.toFixed(1) : 'N/A'}%) | Measured=${inputs.h2sUgL} µg/L @ pH ${h2sMeasuredAtPH} | Limit=${inputs.h2sLimitUgL} µg/L | pH=${inputs.pH} | Crit pH=${isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(2)} | ${
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
          {deffeyesPHError != null && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900"
            >
              DIC/pH chart generation failed. Showing the legacy ALK/DIC Deffeyes chart.
            </div>
          )}
          {dicPhProjectionWarning && (
            <div
              role="status"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900"
            >
              {dicPhProjectionWarning}
            </div>
          )}
          {useLegacyDeffeyes ? (
            <div data-report-chart-id="deffeyes">
              <DeffeyesChart
                data={deffeyesDataWithReagent}
                onDemandPath={onDemandPath.length > 1 ? onDemandPath : undefined}
              />
            </div>
          ) : (
            <DeffeyesPhChart
              data={deffeyesPHDataWithReagent}
              onDemandPath={onDemandChartPath.length > 1 ? onDemandChartPath : undefined}
              onDemandSegments={onDemandChartSegments.length > 0 ? onDemandChartSegments : undefined}
              forceSafetyOverlays={forceReportSafetyOverlays}
            />
          )}
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
      <ResultsPanel outputs={outputs} h2sMeasuredAtPH={h2sMeasuredAtPH} />


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
