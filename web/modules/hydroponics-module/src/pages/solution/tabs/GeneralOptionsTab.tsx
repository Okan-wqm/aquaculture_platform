import React, { useEffect } from 'react';
import { Select, NumberInput, Checkbox, RadioGroup } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import { useFieldVisibility } from '../../../hooks/useFieldVisibility';
import { useSpeciesStages } from '../../../hooks/useSpeciesStages';
import SectionCard from '../../../components/solution/SectionCard';
import DynamicTankTable from '../../../components/solution/DynamicTankTable';
import FertilizerOptionRow from '../../../components/solution/FertilizerOptionRow';
import {
  SPECIES_OPTIONS,
  SEASON_OPTIONS,
  ISE_OPTIONS,
  NS_TYPE_OPTIONS,
  SERVICE_TYPE_OPTIONS,
  CULTIVATION_TYPE_OPTIONS,
  DRAIN_TYPE_OPTIONS,
  TANK_COUNT_OPTIONS,
  ACID_TYPE_OPTIONS,
  ACID_CONCENTRATION_OPTIONS,
  FERTILIZER_P_OPTIONS,
  FERTILIZER_FE_OPTIONS,
  FERTILIZER_MN_OPTIONS,
  FERTILIZER_ZN_OPTIONS,
  FERTILIZER_CU_OPTIONS,
  FERTILIZER_B_OPTIONS,
  FERTILIZER_MO_OPTIONS,
  FERTILIZER_CL_OPTIONS,
  type TankDefinition,
} from '../../../types/solution.types';

const TANK_LABELS = ['A', 'B', 'C'];

const GeneralOptionsTab: React.FC = () => {
  const { settings, setField, mode, setNsType, setReadjustment } = useSolution();
  const g = settings.generalOptions;
  const visibility = useFieldVisibility(mode);
  const { stages, isValidStage } = useSpeciesStages(g.basicOptions.species);

  // Reset stage when species changes and current stage is invalid
  useEffect(() => {
    if (!isValidStage(g.basicOptions.cultivationStage)) {
      setField('generalOptions', 'basicOptions.cultivationStage', 'starter');
      setField('generalOptions', 'basicOptions.stage', 'starter');
    }
  }, [g.basicOptions.species, g.basicOptions.cultivationStage, isValidStage, setField]);

  // Sync stage & cultivationStage
  const handleStageChange = (stage: string) => {
    setField('generalOptions', 'basicOptions.stage', stage);
    setField('generalOptions', 'basicOptions.cultivationStage', stage);
    // If starter, lock NS type to standard
    if (stage === 'starter') {
      setNsType('standard');
    }
  };

  const updateBasic = (key: string, value: string) =>
    setField('generalOptions', `basicOptions.${key}`, value);

  const updateService = (key: string, value: string | number) =>
    setField('generalOptions', `serviceDefinition.${key}`, value);

  const updateAcid = (key: string, value: string) =>
    setField('generalOptions', `acidOptions.${key}`, value);

  const handleTankCountChange = (count: number) => {
    const tanks: TankDefinition[] = Array.from({ length: count }, (_, i) => ({
      tankLabel: TANK_LABELS[i],
      concentrationFactor: g.stockSolutions.tanks[i]?.concentrationFactor ?? 100,
    }));
    setField('generalOptions', 'stockSolutions', { tankCount: count, tanks });
  };

  const updateFertilizer = (category: string, key: string, value: string | number | boolean) => {
    setField('generalOptions', `fertilizerOptions.${category}.${key}`, value);
  };

  const updatePure = (key: string, value: number) =>
    setField('generalOptions', `pureFertilizerPercents.${key}`, value);

  return (
    <div className="space-y-4">
      {/* 2.1 Basic Options */}
      <SectionCard number="2.1" title="Basic Options">
        <div className="space-y-4">
          {/* NS Type Selector */}
          {visibility.showNsTypeSelector ? (
            <div className="mb-3">
              <Select
                label="Nutrient Solution Type"
                options={NS_TYPE_OPTIONS}
                value={g.basicOptions.nsType}
                onChange={(e) => setNsType(e.target.value as 'standard' | 'adjusting')}
              />
            </div>
          ) : (
            <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              Starter stage uses Standard NS formula automatically.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Species"
              options={SPECIES_OPTIONS}
              value={g.basicOptions.species}
              onChange={(e) => updateBasic('species', e.target.value)}
            />
            <Select
              label="Cultivation Stage"
              options={stages}
              value={g.basicOptions.cultivationStage}
              onChange={(e) => handleStageChange(e.target.value)}
            />
            <Select
              label="Season"
              options={SEASON_OPTIONS}
              value={g.basicOptions.season}
              onChange={(e) => updateBasic('season', e.target.value)}
            />
            <Select
              label="ISE Analysis"
              options={ISE_OPTIONS}
              value={g.basicOptions.ise}
              onChange={(e) => updateBasic('ise', e.target.value)}
            />
          </div>

          {/* First Readjustment (adjusting mode only) */}
          {/* BUG-HYD-001 / CRIT-2: Use setReadjustment (the type-safe dedicated action) instead
              of setField with an 'as any' cast. setField on readjustmentSettings was spreading
              undefined when nsType !== 'adjusting', silently producing partial objects. */}
          {visibility.showFirstReadjustment && mode.nsType === 'adjusting' && (
            <div className="pt-3 border-t border-gray-100">
              <Checkbox
                label="Is this the first readjustment?"
                checked={settings.readjustmentSettings?.isFirstReadjustment ?? true}
                onChange={(e) => setReadjustment({ isFirstReadjustment: e.target.checked })}
              />
            </div>
          )}
        </div>
      </SectionCard>

      {/* 2.2 Define Requested Service */}
      <SectionCard number="2.2" title="Define Requested Service">
        <div className="space-y-4">
          <Select
            label="System Type"
            options={SERVICE_TYPE_OPTIONS}
            value={g.serviceDefinition.systemType}
            onChange={(e) => updateService('systemType', e.target.value)}
          />

          {/* Closed system: Cultivation Type */}
          {visibility.showCultivationType && (
            <RadioGroup
              label="Cultivation Type"
              name="cultivationType"
              options={CULTIVATION_TYPE_OPTIONS}
              value={g.serviceDefinition.cultivationType ?? 'new_planting'}
              onChange={(val) => updateService('cultivationType', val)}
              vertical={false}
            />
          )}

          {!visibility.showCultivationType && (
            <RadioGroup
              label="Drain Type"
              name="drainType"
              options={DRAIN_TYPE_OPTIONS}
              value={g.serviceDefinition.drainType}
              onChange={(val) => updateService('drainType', val)}
              vertical={false}
            />
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Drainage %"
              value={g.serviceDefinition.drainPercent}
              onChange={(e) => updateService('drainPercent', parseFloat(e.target.value) || 0)}
              unit="%"
              min={0}
              max={100}
            />
            <NumberInput
              label="Target EC"
              value={g.serviceDefinition.targetEC}
              onChange={(e) => updateService('targetEC', parseFloat(e.target.value) || 0)}
              unit="mS/cm"
              min={0}
              max={10}
              step={0.1}
            />
          </div>

          {/* Closed system extra fields */}
          {visibility.showTargetDrainagePercent && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-gray-100">
              <NumberInput
                label="Target Drainage %"
                value={g.serviceDefinition.targetDrainagePercent}
                onChange={(e) => updateService('targetDrainagePercent', parseFloat(e.target.value) || 0)}
                unit="%"
                min={0}
                max={100}
              />
              {visibility.showCurrentDrainageEc && (
                <NumberInput
                  label="Current Drainage EC"
                  value={g.serviceDefinition.currentDrainageEc}
                  onChange={(e) => updateService('currentDrainageEc', parseFloat(e.target.value) || 0)}
                  unit="mS/cm"
                  min={0}
                  max={15}
                  step={0.1}
                />
              )}
            </div>
          )}
        </div>
      </SectionCard>

      {/* 2.3 Stock Solutions */}
      <SectionCard number="2.3" title="Stock Solutions">
        <div className="space-y-4">
          <Select
            label="Number of Tanks"
            options={TANK_COUNT_OPTIONS}
            value={String(g.stockSolutions.tankCount)}
            onChange={(e) => handleTankCountChange(parseInt(e.target.value, 10))}
            className="max-w-xs"
          />
          <DynamicTankTable
            tanks={g.stockSolutions.tanks}
            onChange={(tanks) =>
              setField('generalOptions', 'stockSolutions', { ...g.stockSolutions, tanks })
            }
          />
        </div>
      </SectionCard>

      {/* 2.4 Acid for pH */}
      <SectionCard number="2.4" title="Acid for pH Adjustment">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Acid Type"
            options={ACID_TYPE_OPTIONS}
            value={g.acidOptions.acidType}
            onChange={(e) => updateAcid('acidType', e.target.value)}
          />
          <Select
            label="Acid Concentration"
            options={ACID_CONCENTRATION_OPTIONS}
            value={g.acidOptions.acidConcentration}
            onChange={(e) => updateAcid('acidConcentration', e.target.value)}
          />
        </div>
      </SectionCard>

      {/* 2.5 Fertilizer Options */}
      <SectionCard number="2.5" title="Fertilizer Options">
        <div className="space-y-1">
          <FertilizerOptionRow
            label="Phosphorus (P)"
            fertilizerOptions={FERTILIZER_P_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.phosphorus.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('phosphorus', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.phosphorus.purityPercent}
            onPurityChange={(v) => updateFertilizer('phosphorus', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Iron (Fe)"
            fertilizerOptions={FERTILIZER_FE_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.iron.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('iron', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.iron.purityPercent}
            onPurityChange={(v) => updateFertilizer('iron', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Manganese (Mn)"
            fertilizerOptions={FERTILIZER_MN_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.manganese.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('manganese', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.manganese.purityPercent}
            onPurityChange={(v) => updateFertilizer('manganese', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Zinc (Zn)"
            fertilizerOptions={FERTILIZER_ZN_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.zinc.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('zinc', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.zinc.purityPercent}
            onPurityChange={(v) => updateFertilizer('zinc', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Copper (Cu)"
            fertilizerOptions={FERTILIZER_CU_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.copper.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('copper', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.copper.purityPercent}
            onPurityChange={(v) => updateFertilizer('copper', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Boron (B)"
            fertilizerOptions={FERTILIZER_B_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.boron.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('boron', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.boron.purityPercent}
            onPurityChange={(v) => updateFertilizer('boron', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Molybdenum (Mo)"
            fertilizerOptions={FERTILIZER_MO_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.molybdenum.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('molybdenum', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.molybdenum.purityPercent}
            onPurityChange={(v) => updateFertilizer('molybdenum', 'purityPercent', v)}
          />
          <FertilizerOptionRow
            label="Chloride (Cl)"
            fertilizerOptions={FERTILIZER_CL_OPTIONS}
            selectedFertilizer={g.fertilizerOptions.chloride.fertilizer}
            onFertilizerChange={(v) => updateFertilizer('chloride', 'fertilizer', v)}
            purityPercent={g.fertilizerOptions.chloride.purityPercent}
            onPurityChange={(v) => updateFertilizer('chloride', 'purityPercent', v)}
          />
          <div className="pt-3 border-t border-gray-100 mt-3">
            <Checkbox
              label="Use Ammonium Nitrate (NH4NO3)"
              checked={g.fertilizerOptions.useAmmoniumNitrate}
              onChange={(e) =>
                setField('generalOptions', 'fertilizerOptions.useAmmoniumNitrate', e.target.checked)
              }
            />
          </div>
        </div>
      </SectionCard>

      {/* 2.6 Pure Fertilizer Percents */}
      <SectionCard number="2.6" title="Pure Fertilizer %">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput
            label="HNO3 %"
            value={g.pureFertilizerPercents.hno3}
            onChange={(e) => updatePure('hno3', parseFloat(e.target.value) || 0)}
            unit="%"
            min={0}
            max={100}
          />
          <NumberInput
            label="H3PO4 %"
            value={g.pureFertilizerPercents.h3po4}
            onChange={(e) => updatePure('h3po4', parseFloat(e.target.value) || 0)}
            unit="%"
            min={0}
            max={100}
          />
          <NumberInput
            label="H2SO4 %"
            value={g.pureFertilizerPercents.h2so4}
            onChange={(e) => updatePure('h2so4', parseFloat(e.target.value) || 0)}
            unit="%"
            min={0}
            max={100}
          />
          <NumberInput
            label="K2SiO3 %"
            value={g.pureFertilizerPercents.k2sio3}
            onChange={(e) => updatePure('k2sio3', parseFloat(e.target.value) || 0)}
            unit="%"
            min={0}
            max={100}
          />
        </div>
      </SectionCard>
    </div>
  );
};

export default GeneralOptionsTab;
