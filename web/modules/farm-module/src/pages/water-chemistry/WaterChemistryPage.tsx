/**
 * Water Chemistry Page
 * Full-featured water chemistry calculator with Millero equations,
 * Deffeyes diagram, toxic zone analysis, and chemical dosing.
 *
 * Ported from Python v1.py PyQt5 application.
 */
import {
  applyResolved,
  buildDeffeyesData,
  computeWaterChemistryOutputs,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  useCanMutate,
  useI18n,
  type InputOverrides,
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
import { useWaterChemistryInputs } from '../../hooks/useParameterSources';
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
  // The operator's entries; a measurement point's values are laid over them.
  const [manualInputs, setManualInputs] = useState<WaterChemistryInputs>(() => ({
    ...DEFAULT_WATER_CHEMISTRY_INPUTS,
  }));
  const [valuesPoint, setValuesPoint] = useState<PointRef | null>(null);
  // Session-only corrections of a point's values (never written back).
  const [overrides, setOverrides] = useState<InputOverrides>({});
  const pointInputs = useWaterChemistryInputs(valuesPoint);
  const applied = useMemo(
    () =>
      valuesPoint === null || pointInputs.data === undefined
        ? null
        : applyResolved(manualInputs, [pointInputs.data], { overrides, uncovered: 'base' }),
    [valuesPoint, pointInputs.data, manualInputs, overrides],
  );
  // Manual: the entries. A point: its values over the entries — null while any
  // value it covers is missing (or not yet read): the engine does not run then.
  const inputs: WaterChemistryInputs | null =
    valuesPoint === null ? manualInputs : applied === null ? null : applied.inputs;

  const changeValuesPoint = (point: PointRef | null): void => {
    setValuesPoint(point);
    setOverrides({});
  };
  const override = (field: ResolvableField, value: number | null): void => {
    setOverrides((prev) => {
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

  const missing = applied === null ? [] : applied.missing;
  return (
    <div className="space-y-2">
      <ValuesSourceBar
        point={valuesPoint}
        onPointChange={changeValuesPoint}
        inputSet={pointInputs.data}
        applied={applied}
        loadError={pointInputs.error}
        now={Date.now()}
        onOverride={override}
      />

      {/* ROW 1: Horizontal Input Bar — the operator's entries */}
      <InputPanel
        inputs={manualInputs}
        onChange={setManualInputs}
        selectedReagents={selectedReagents}
        onReagentsChange={setSelectedReagents}
        onDemandAmounts={onDemandAmounts}
        onDemandAmountsChange={setOnDemandAmounts}
      />

      {inputs === null ? (
        <div
          role="status"
          data-testid="engine-not-ready"
          className="rounded-lg border border-dashed border-warning-300 bg-warning-50 p-4 text-sm text-warning-800 dark:border-warning-700 dark:bg-warning-900/20 dark:text-warning-200"
        >
          {pointInputs.error !== null
            ? 'The values at this point could not be read, so the calculation does not run.'
            : applied === null
              ? 'Choose a system or a tank to read its values.'
              : `The calculation does not run on missing values: ${missing
                  .map((field) => t(`wqSource.field.${field}`))
                  .join(', ')} — measure them, or correct them above for this session.`}
        </div>
      ) : (
        <CalculatorResults
          inputs={inputs}
          selectedReagents={selectedReagents}
          onDemandAmounts={onDemandAmounts}
        />
      )}
    </div>
  );
};

/**
 * The charts, results and report of one input record — rendered only when the
 * record is complete (the engine-not-ready guard is the caller's).
 */
const CalculatorResults: React.FC<{
  inputs: WaterChemistryInputs;
  selectedReagents: string[];
  onDemandAmounts: Record<string, number>;
}> = ({ inputs, selectedReagents, onDemandAmounts }) => {
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
        `${inputs.volume} m³`,
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
      <ResultsPanel outputs={outputs} />
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
