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
  useCanMutate,
  type WaterChemistryInputs,
} from '@aquaculture/shared-ui';
import { alkMgToMeq, calcDicOfAlk, calcForwardDosing, REAGENTS } from '@platform/aquaculture-engines';
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
import { reportWaterChemistryDiagnostic } from './waterChemistryDiagnostics';
import {
  buildWaterChemistryReportHtml,
  collectWaterChemistryReportCharts,
  printWaterChemistryReport,
} from './waterChemistryReportExport';
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
