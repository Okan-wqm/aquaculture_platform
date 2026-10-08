/**
 * Water Chemistry Page
 * Full-featured water chemistry calculator with Millero equations,
 * Deffeyes diagram, toxic zone analysis, and chemical dosing.
 *
 * Ported from Python v1.py PyQt5 application.
 */
import {
  buildDeffeyesData,
  composePointInputs,
  engineRecordOf,
  usableValues,
  type EngineRecord,
  type OperatorEntries,
  computeWaterChemistryOutputs,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  useCanMutate,
  useI18n,
  type PointRef,
  type ResolvableField,
  type WaterChemistryInputs,
  PageHeader,
  Button,
} from '@aquaculture/shared-ui';
import {
  alkMgToMeq,
  calcDicOfAlk,
  calcForwardDosing,
  REAGENTS,
} from '@platform/aquaculture-engines';
import React, { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';

// Component imports
// DeffeyesChart + ResultsPanel are the SSoT presentation, imported from shared-ui
// SOURCE (per-remote bundle, not the federation singleton — keeps recharts out of
// the singleton). The rest are farm-module-local tabs/panels.
import {
  CalciteSaturationChart,
  CarbonateVsPhChart,
  DeffeyesChart,
  H2sVsPhChart,
  ResultsPanel,
  UiaVsPhChart,
} from '@platform/shared-ui/water-chemistry/components';
import { BulkRecordTab } from './components/BulkRecordTab';
import { HistoryTab } from './components/HistoryTab';
import InputPanel from './components/InputPanel';
import OnDemandPanel from './components/OnDemandPanel';
import { ParameterConfigManager } from './components/ParameterConfigManager';
import { RecordTab } from './components/RecordTab';
import { SourcesTab } from './components/sources/SourcesTab';
import { ValuesSourceBar } from './components/ValuesSourceBar';
import { usePointSets } from '../../hooks/useParameterSources';
import { reportWaterChemistryDiagnostic } from './waterChemistryDiagnostics';
import {
  buildWaterChemistryReportHtml,
  collectWaterChemistryReportCharts,
  printWaterChemistryReport,
} from './waterChemistryReportExport';
import { Printer } from 'lucide-react';
// ============================================================================
// OVERVIEW CONTENT - Upgraded with Millero engine
// ============================================================================

const OverviewContent: React.FC = () => {
  const { t } = useI18n();
  // The operator's record: in manual mode every field; at a point only the
  // settings (targets, limits, fish) — the measured fields are the point's.
  const [manualInputs, setManualInputs] = useState<WaterChemistryInputs>(() => ({
    ...DEFAULT_WATER_CHEMISTRY_INPUTS,
  }));
  const [valuesPoint, setValuesPoint] = useState<PointRef | null>(null);
  // Session-only corrections and entries at the point (never written back).
  const [entries, setEntries] = useState<OperatorEntries>({});
  const pointSets = usePointSets(valuesPoint);
  const composed = useMemo(
    () =>
      valuesPoint === null || pointSets.sets === null
        ? null
        : composePointInputs(pointSets.sets, entries),
    [valuesPoint, pointSets.sets, entries],
  );
  const record: EngineRecord | null =
    valuesPoint === null
      ? { inputs: manualInputs, dosing: true }
      : composed === null
        ? null
        : engineRecordOf(composed, manualInputs);

  const changeValuesPoint = (point: PointRef | null): void => {
    setValuesPoint(point);
    setEntries({});
  };
  const enter = (field: ResolvableField, value: number | null): void => {
    setEntries((prev) => {
      const next = { ...prev };
      if (value === null) delete next[field];
      else next[field] = value;
      return next;
    });
  };
  const [selectedReagents, setSelectedReagents] = useState<string[]>([
    'Sodium Bicarbonate',
    'Sodium Hydroxide',
    'Add CO₂',
    'De-gas CO₂',
  ]);
  const [onDemandAmounts, setOnDemandAmounts] = useState<Record<string, number>>({});
  const pointValues = composed === null ? undefined : usableValues(composed);

  const notReady = (): string => {
    if (pointSets.error !== null)
      return t('wqSource.ui.readFailed', { error: pointSets.error.message });
    if (valuesPoint === null || composed === null) {
      return pointSets.loading ? t('wqSource.ui.loadingPoint') : t('wqSource.ui.chooseCalcPoint');
    }
    if (record !== null && record.inputs === null) {
      return t('wqSource.blocking', {
        fields: record.blocking.map((entry) => t(`wqSource.field.${entry.field}`)).join(', '),
      });
    }
    return t('wqSource.ui.loadingPoint');
  };
  const dosingUnavailable =
    composed === null || composed.dosing.available
      ? undefined
      : t(`wqSource.dosing.${composed.dosing.reason}`);

  return (
    <div className="space-y-2">
      <ValuesSourceBar
        point={valuesPoint}
        onPointChange={changeValuesPoint}
        ownSet={pointSets.sets === null ? null : pointSets.sets.own}
        composed={composed}
        loading={pointSets.loading}
        loadError={pointSets.error}
        refreshFailed={pointSets.refreshFailed}
        now={Date.now()}
        onEnter={enter}
      />

      {/* ROW 1: Horizontal Input Bar — the operator's entries; the point's values read-only */}
      <InputPanel
        inputs={manualInputs}
        onChange={setManualInputs}
        selectedReagents={selectedReagents}
        onReagentsChange={setSelectedReagents}
        onDemandAmounts={onDemandAmounts}
        onDemandAmountsChange={setOnDemandAmounts}
        pointValues={pointValues}
      />

      {record === null || record.inputs === null ? (
        <div
          role="status"
          data-testid="engine-not-ready"
          className="rounded-lg border border-dashed border-warning-300 bg-warning-50 p-4 text-sm text-warning-800 dark:border-warning-700 dark:bg-warning-900/20 dark:text-warning-200"
        >
          {notReady()}
        </div>
      ) : (
        <CalculatorResults
          inputs={record.inputs}
          // Without a dose here (a tank, a dosing set not READY) no reagent is
          // passed: the volume is then never read.
          selectedReagents={record.dosing ? selectedReagents : NO_REAGENTS}
          onDemandAmounts={record.dosing ? onDemandAmounts : NO_AMOUNTS}
          dosingUnavailable={dosingUnavailable}
        />
      )}
    </div>
  );
};

const NO_REAGENTS: string[] = [];
const NO_AMOUNTS: Record<string, number> = {};

/**
 * The charts, results and report of one input record — rendered only when the
 * record is complete (the engine-not-ready guard is the caller's).
 */
const CalculatorResults: React.FC<{
  inputs: WaterChemistryInputs;
  selectedReagents: string[];
  onDemandAmounts: Record<string, number>;
  /** Why no dose is computed here (shown in place of the recipes). */
  dosingUnavailable: string | undefined;
}> = ({ inputs, selectedReagents, onDemandAmounts, dosingUnavailable }) => {
  // Convert inputs to engine parameters
  const alkMeq = alkMgToMeq(inputs.alkalinityMg);

  // Deffeyes chart data + reagent visualization — shared SSoT builder (identical
  // logic for the farm calculator and the sensor-module cards).
  const deffeyesDataWithReagent = useMemo(
    () =>
      buildDeffeyesData(inputs, selectedReagents, {
        onError: (_stage, e) => reportWaterChemistryDiagnostic('deffeyes-data-generation', e),
      }),
    [inputs, selectedReagents],
  );

  // Calculate outputs — shared SSoT compute (identical numbers everywhere).
  const outputs = useMemo(
    () => computeWaterChemistryOutputs(inputs, selectedReagents),
    [inputs, selectedReagents],
  );

  // On-demand forward dosing path — derived from the amounts Record
  const onDemandPath = useMemo(() => {
    const activeInputs = REAGENTS.filter((r) => (onDemandAmounts[r.name] || 0) > 0).map((r) => ({
      reagentKey: r.name,
      amountGrams: onDemandAmounts[r.name],
    }));
    if (activeInputs.length === 0) return [];
    const currentDIC = calcDicOfAlk(alkMeq, inputs.pH, inputs.tempC, inputs.salinity);
    return calcForwardDosing(
      { dic: currentDIC, alk: alkMeq, tempC: inputs.tempC, salinity: inputs.salinity },
      inputs.volume,
      activeInputs,
    );
  }, [onDemandAmounts, alkMeq, inputs.pH, inputs.tempC, inputs.salinity, inputs.volume]);

  const chartAreaRef = React.useRef<HTMLDivElement>(null);
  const [forceReportSafetyOverlays, setForceReportSafetyOverlays] = useState(false);

  const handlePrint = (): void => {
    if (!chartAreaRef.current) return;

    const { charts, deffeyesChart } = collectWaterChemistryReportCharts(chartAreaRef.current);

    // Build parameters table
    const params = [
      ['Temperature', `${inputs.tempC} °C`, 'pH (Realtime)', `${inputs.pH} NBS`],
      ['Salinity', `${inputs.salinity} ppt`, 'Alkalinity', `${inputs.alkalinityMg} mg/L CaCO₃`],
      [
        'Target pH',
        `${inputs.targetpH} NBS`,
        'Target Alkalinity',
        `${inputs.targetAlkalinityMg} mg/L CaCO₃`,
      ],
      ['TAN', `${inputs.tan} mg/L`, 'NH₃-N Limit', `${inputs.unIonizedNH3} mg/L`],
      ['CO₂ Toxic', `${inputs.co2Toxic} mg/L`, 'H₂S Measured', `${inputs.h2sUgL} µg/L`],
      [
        'H₂S Limit',
        `${inputs.h2sLimitUgL} µg/L`,
        'Current H₂S',
        `${outputs.currentH2S.toFixed(1)} µg/L`,
      ],
      ['Ca²⁺', `${inputs.caMgL} mg/L`, 'Chart', 'ALK/DIC Deffeyes'],
      ['Fish Type', inputs.fishType, 'Fish Size', inputs.fishSize],
      [
        'Volume',
        Number.isNaN(inputs.volume) ? '—' : `${inputs.volume} m³`,
        'Alk Range',
        `${inputs.alkMinMg} - ${inputs.alkMaxMg} mg/L`,
      ],
    ];

    const resultsRows = [
      [
        'Toxic NH₃ pH Border',
        isNaN(outputs.toxicNH3pH) ? 'N/A' : outputs.toxicNH3pH.toFixed(3),
        'Current NH₃-N',
        `${outputs.currentUIA.toFixed(4)} mg/L`,
      ],
      [
        'Toxic CO₂ pH Border',
        isNaN(outputs.toxicCO2pH) ? 'N/A' : outputs.toxicCO2pH.toFixed(3),
        'Current CO₂',
        `${outputs.currentCO2.toFixed(2)} mg/L`,
      ],
      [
        'Toxic H₂S pH Border',
        isNaN(outputs.toxicH2SpH) ? 'N/A' : outputs.toxicH2SpH.toFixed(3),
        'Total Sulfide',
        `${outputs.totalSulfide > 10000 ? '> 10000' : outputs.totalSulfide.toFixed(1)} µg/L`,
      ],
      [
        'UIA Status',
        outputs.uiaStatusLevel.toUpperCase(),
        'H₂S Status',
        outputs.h2sStatusLevel.toUpperCase(),
      ],
      [
        'Current DIC',
        `${outputs.currentDIC.toFixed(3)} mmol/L`,
        'Target DIC',
        `${outputs.targetDIC.toFixed(3)} mmol/L`,
      ],
    ];

    const result = printWaterChemistryReport(
      buildWaterChemistryReportHtml({
        generatedAt: new Date(),
        parameters: params,
        results: resultsRows,
        charts,
        deffeyesChart,
      }),
    );
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
      {/* Print button */}
      <div className="flex justify-end">
        <Button variant="secondary" size="xs" onClick={handlePrintClick}>
          <Printer className="w-3.5 h-3.5" aria-hidden="true" />
          Print Report
        </Button>
      </div>

      {/* Dosing Simulator Results — appears between input and charts when active */}
      <OnDemandPanel steps={onDemandPath} co2ToxicMgL={inputs.co2Toxic} />

      {/* ROW 2: 3-Column Chart Layout - [UIA+H2S] | [Deffeyes] | [CO2+Calcite] */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.6fr_1fr] gap-4 items-stretch">
        {/* Left Column: UIA + H2S stacked (shared SSoT charts) */}
        <div className="space-y-4 flex flex-col">
          <UiaVsPhChart inputs={inputs} outputs={outputs} />
          <H2sVsPhChart inputs={inputs} outputs={outputs} />
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

        {/* Right Column: CO2 + Calcite stacked (shared SSoT charts) */}
        <div className="space-y-4 flex flex-col">
          <CarbonateVsPhChart inputs={inputs} outputs={outputs} />
          <CalciteSaturationChart inputs={inputs} outputs={outputs} />
        </div>
      </div>

      {/* ROW 3: Results - UIA Status | Calculated Values | Dosing Recipes */}
      <ResultsPanel outputs={outputs} dosingUnavailable={dosingUnavailable} />
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

type TabId = 'calculator' | 'record' | 'bulk' | 'history' | 'sources' | 'parameters';

const WaterChemistryPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const canBulk = useCanMutate('createBatchWaterQualityMeasurements');
  const activeTab: TabId =
    tabParam === 'record'
      ? 'record'
      : tabParam === 'bulk' && canBulk
        ? 'bulk'
        : tabParam === 'history'
          ? 'history'
          : tabParam === 'sources'
            ? 'sources'
            : tabParam === 'parameters'
              ? 'parameters'
              : 'calculator';

  const handleTabChange = (tabId: TabId): void => {
    setSearchParams((prev) => {
      prev.set('tab', tabId);
      return prev;
    });
  };

  const tabs: { id: TabId; name: string }[] = [
    { id: 'calculator', name: 'Calculator' },
    { id: 'record', name: 'Record' },
    ...(canBulk ? [{ id: 'bulk' as TabId, name: 'Bulk' }] : []),
    { id: 'history', name: 'History' },
    { id: 'sources', name: 'Sources' },
    { id: 'parameters', name: 'Parameters' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 shadow">
        <PageHeader
          title="Water Chemistry"
          description="Calculator, analysis, and historical water quality data"
          className="px-4 sm:px-6 py-6"
        />
      </div>

      {/* Tabs */}
      <div className="px-4 sm:px-6">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-8" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? 'border-info-500 text-info-600 dark:text-info-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500'
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
        {activeTab === 'sources' && <SourcesTab />}
        {activeTab === 'parameters' && <ParameterConfigManager />}
      </div>
    </div>
  );
};

export default WaterChemistryPage;
