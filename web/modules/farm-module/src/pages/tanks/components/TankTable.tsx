/**
 * Tank Table — the /sites/tanks unit list, column-driven.
 *
 * Design reference: design_handoff tenant console "Tanks" — a dense table
 * whose DEFAULT nine columns are Unit (code + department · site) · Batch
 * (batch + species) · Fish · Avg weight · Biomass · Density with capacity
 * bar · FCR · Survival · Last fed. The full model carries 30 selectable
 * columns (tanksV2.col.*) through the column-visibility menu; the
 * cleaner-fish tab renders the cf* per-batch columns with rowspan tank
 * cells, preserving the legacy multi-batch view inside the new design.
 *
 * Row click opens the detail drawer; the selected row is highlighted and
 * over-capacity rows carry the warning tint.
 */
import React from 'react';
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { TankWithBatch, TankColumn } from '../types';

interface TankTableProps {
  tanks: TankWithBatch[];
  /** Visible columns (already filtered by the column-visibility state). */
  columns: TankColumn[];
  /** Resolved species display name by species code. */
  speciesNames: Record<string, string>;
  /** Which tab's column model renders — production or cleaner fish. */
  variant: 'production' | 'cleanerFish';
  /** Currently open drawer unit — its row stays highlighted. */
  selectedTankId: string | null;
  onRowClick: (tank: TankWithBatch) => void;
}

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  ACTIVE: 'tanksV2.status.ACTIVE',
  OPERATIONAL: 'tanksV2.status.OPERATIONAL',
  PREPARING: 'tanksV2.status.PREPARING',
  MAINTENANCE: 'tanksV2.status.MAINTENANCE',
  CLEANING: 'tanksV2.status.CLEANING',
  HARVESTING: 'tanksV2.status.HARVESTING',
  FALLOW: 'tanksV2.status.FALLOW',
  QUARANTINE: 'tanksV2.status.QUARANTINE',
  OUT_OF_SERVICE: 'tanksV2.status.OUT_OF_SERVICE',
  DECOMMISSIONED: 'tanksV2.status.DECOMMISSIONED',
};

const CATEGORY_LABEL_KEYS: Record<string, MessageKey> = {
  tank: 'tanksV2.filter.tanks',
  pond: 'tanksV2.filter.ponds',
  cage: 'tanksV2.filter.cages',
};

export const TankTable: React.FC<TankTableProps> = ({
  tanks,
  columns,
  speciesNames,
  variant,
  selectedTankId,
  onRowClick,
}) => {
  const { t, locale } = useI18n();
  const numberLocale = locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (value: number | undefined, decimals = 1): string => {
    if (value === undefined || value === null) return '—';
    return value.toLocaleString(numberLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  };
  const formatDate = (value: string | undefined): string => {
    if (!value) return '—';
    return new Date(value).toLocaleDateString(numberLocale, {
      day: '2-digit',
      month: '2-digit',
    });
  };

  if (tanks.length === 0) {
    return (
      <div className="border border-gray-200 bg-white px-4 py-10 text-center text-gray-500">
        {t('tanksV2.grid.noResults')}
      </div>
    );
  }

  const alignClass = (col: TankColumn): string =>
    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left';

  const locationLine = (tank: TankWithBatch): string =>
    [tank.departmentName, tank.siteName].filter(Boolean).join(' · ');

  const batchLabel = (tank: TankWithBatch): string | undefined => {
    const details = tank.batchDetails;
    if (details && details.length > 1) return details.map((d) => d.batchNumber).join(' + ');
    return tank.batchNumber;
  };

  const speciesLabel = (tank: TankWithBatch): string =>
    tank.speciesCode ? (speciesNames[tank.speciesCode] ?? tank.speciesCode) : '';

  const capOf = (tank: TankWithBatch): number | undefined =>
    tank.capacityUsedPercent !== undefined && tank.capacityUsedPercent !== null
      ? Math.min(tank.capacityUsedPercent, 100)
      : undefined;

  /** Density cell — value + bold capacity percent + 8px bar (design). */
  const renderDensityCell = (tank: TankWithBatch): React.ReactNode => {
    if (tank.density === undefined || tank.density === null) return '—';
    const cap = capOf(tank);
    return (
      <div className="w-[170px]">
        <div className="mb-1 flex justify-between gap-2 text-[14px]">
          <span className="whitespace-nowrap">{fmt(tank.density)} kg/m³</span>
          <span className="font-bold">
            {tank.capacityUsedPercent !== undefined && tank.capacityUsedPercent !== null
              ? `%${fmt(tank.capacityUsedPercent, 0)}`
              : ''}
          </span>
        </div>
        <div className="h-2 border border-gray-300">
          <div
            className={`h-full ${tank.isOverCapacity ? 'bg-amber-500' : 'bg-blue-600'}`}
            style={{ width: `${cap ?? 0}%` }}
          />
        </div>
      </div>
    );
  };

  /** Unit cell — big code + department · site subline (design). */
  const renderUnitCell = (tank: TankWithBatch): React.ReactNode => (
    <div className="pr-3">
      <div className="text-lg font-semibold leading-tight text-gray-900">{tank.code}</div>
      <div className="whitespace-nowrap text-[13px] text-gray-500">
        {locationLine(tank) || tank.name}
      </div>
    </div>
  );

  /** Production cell renderer — design cells for the core columns, plain for the rest. */
  const renderCell = (tank: TankWithBatch, key: string): React.ReactNode => {
    switch (key) {
      case 'code':
        return renderUnitCell(tank);
      case 'name':
        return <span className="font-medium text-gray-900">{tank.name}</span>;
      case 'batchNumber': {
        const label = batchLabel(tank);
        const species = speciesLabel(tank);
        return label ? (
          <div>
            <div className="whitespace-nowrap font-medium text-gray-900">{label}</div>
            {species && <div className="text-[13px] text-gray-500">{species}</div>}
          </div>
        ) : (
          <span className="italic text-gray-400">{t('tanksV2.unit.emptyReady')}</span>
        );
      }
      case 'category': {
        const labelKey = CATEGORY_LABEL_KEYS[tank.category];
        return labelKey ? t(labelKey) : tank.category;
      }
      case 'status': {
        const labelKey = STATUS_LABEL_KEYS[tank.status];
        return labelKey ? t(labelKey) : tank.status;
      }
      case 'departmentName':
        return tank.departmentName || '—';
      case 'tankType':
        return tank.tankType || '—';
      case 'material':
        return tank.material || '—';
      case 'waterType':
        return tank.waterType || '—';
      case 'volume':
        return tank.volume !== undefined && tank.volume !== null ? `${fmt(tank.volume)} m³` : '—';
      case 'maxBiomass':
        return fmt(tank.maxBiomass, 0);
      case 'maxDensity':
        return fmt(tank.maxDensity, 0);
      case 'speciesCode':
        return speciesLabel(tank) || '—';
      case 'pieces':
        return tank.batchNumber ? fmt(tank.pieces, 0) : '—';
      case 'avgWeight':
        return tank.avgWeight !== undefined && tank.avgWeight !== null
          ? `${fmt(tank.avgWeight, tank.avgWeight < 1 ? 2 : 0)} g`
          : '—';
      case 'biomass':
        return tank.biomass !== undefined && tank.biomass !== null
          ? `${fmt(tank.biomass, tank.biomass < 10 ? 2 : 0)} kg`
          : '—';
      case 'density':
        return renderDensityCell(tank);
      case 'survivalRate':
        return tank.survivalRate !== undefined && tank.survivalRate !== null
          ? `%${fmt(tank.survivalRate, 1)}`
          : '—';
      case 'mortalityRate':
        return tank.mortalityRate !== undefined && tank.mortalityRate !== null
          ? `%${fmt(tank.mortalityRate, 2)}`
          : '—';
      case 'fcr':
        return fmt(tank.fcr, 2);
      case 'growthRate':
        return fmt(tank.growthRate, 2);
      case 'sgr':
        return tank.sgr !== undefined && tank.sgr !== null ? `%${fmt(tank.sgr, 2)}` : '—';
      case 'capacityUsedPercent':
        return tank.capacityUsedPercent !== undefined && tank.capacityUsedPercent !== null
          ? `%${fmt(tank.capacityUsedPercent, 0)}`
          : '—';
      case 'daysSinceStocking':
        return fmt(tank.daysSinceStocking, 0);
      case 'lastFeedingAt':
        return formatDate(tank.lastFeedingAt);
      case 'lastSamplingAt':
        return formatDate(tank.lastSamplingAt);
      case 'projectedHarvestDate':
        return formatDate(tank.projectedHarvestDate);
      case 'feedCode':
        return tank.feedName || tank.feedCode || '—';
      case 'feedingRatePercent':
        return tank.feedingRatePercent !== undefined && tank.feedingRatePercent !== null
          ? `%${fmt(tank.feedingRatePercent, 2)}`
          : '—';
      case 'dailyFeedKg':
        return tank.dailyFeedKg !== undefined && tank.dailyFeedKg !== null
          ? `${fmt(tank.dailyFeedKg, 2)} kg`
          : '—';
      default:
        return '—';
    }
  };

  /** Cleaner-fish tank-level cell renderer (rowspan'd on multi-batch rows). */
  const renderCleanerTankCell = (tank: TankWithBatch, key: string): React.ReactNode => {
    switch (key) {
      case 'code':
        return renderUnitCell(tank);
      case 'name':
        return <span className="font-medium text-gray-900">{tank.name}</span>;
      case 'category': {
        const labelKey = CATEGORY_LABEL_KEYS[tank.category];
        return labelKey ? t(labelKey) : tank.category;
      }
      case 'status': {
        const labelKey = STATUS_LABEL_KEYS[tank.status];
        return labelKey ? t(labelKey) : tank.status;
      }
      case 'departmentName':
        return tank.departmentName || '—';
      case 'volume':
        return tank.volume !== undefined && tank.volume !== null ? `${fmt(tank.volume)} m³` : '—';
      default:
        return '—';
    }
  };

  /** Cleaner-fish per-batch cell renderer. */
  const renderCleanerBatchCell = (
    tank: TankWithBatch,
    key: string,
    batchIndex: number,
  ): React.ReactNode => {
    const cf = tank.cleanerFishDetails?.[batchIndex];
    if (!cf) return '—';

    switch (key) {
      case 'cfBatchNumber':
        return <span className="font-mono text-sm">{cf.batchNumber}</span>;
      case 'cfSpecies':
        return cf.speciesName;
      case 'cfQuantity':
        return fmt(cf.quantity, 0);
      case 'cfAvgWeight':
        return `${fmt(cf.avgWeightG, 1)} g`;
      case 'cfBiomass':
        return `${fmt(cf.biomassKg, 1)} kg`;
      case 'cfSourceType':
        return t(
          cf.sourceType === 'farmed' ? 'tanksV2.cfCol.source.farmed' : 'tanksV2.cfCol.source.wild',
        );
      case 'cfDeployedAt':
        return formatDate(cf.deployedAt);
      case 'cfBatchCount':
        return batchIndex === 0 ? fmt(tank.cleanerFishDetails?.length || 0, 0) : null;
      case 'cfInitialQuantity':
        return fmt(cf.initialQuantity, 0);
      case 'cfTotalMortality':
        return fmt(cf.totalMortality, 0);
      case 'cfMortalityRate':
        return cf.mortalityRate !== undefined ? `%${fmt(cf.mortalityRate, 2)}` : '—';
      case 'cfLastMortalityAt':
        return cf.lastMortalityAt ? formatDate(cf.lastMortalityAt) : '—';
      case 'cfSurvivalRate':
        if (cf.initialQuantity && cf.initialQuantity > 0) {
          return `%${fmt((cf.quantity / cf.initialQuantity) * 100, 1)}`;
        }
        return '—';
      default:
        return '—';
    }
  };

  const isTankLevelColumn = (key: string): boolean => !key.startsWith('cf');

  const rowClasses = (tank: TankWithBatch): string => {
    const selected = tank.id === selectedTankId;
    const over = !!tank.isOverCapacity;
    return `cursor-pointer border-l-4 transition-colors ${
      selected
        ? 'border-l-blue-600 bg-blue-50'
        : over
          ? 'border-l-amber-500 bg-amber-50 hover:bg-amber-100/60'
          : 'border-l-transparent hover:bg-gray-50'
    }`;
  };

  return (
    <div className="overflow-x-auto border border-gray-200 bg-white">
      <table className="w-full text-[15px]">
        <thead className="bg-gray-50">
          <tr>
            {columns.map((col, index) => (
              <th
                key={col.key}
                className={`border-l border-gray-200 px-3 py-3 text-xs font-medium text-gray-500 ${alignClass(
                  col,
                )} ${index === 0 ? 'border-l-0 pl-6' : ''}`}
              >
                {t(col.header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {variant === 'production'
            ? tanks.map((tank) => (
                <tr
                  key={tank.id}
                  onClick={() => onRowClick(tank)}
                  className={rowClasses(tank)}
                  aria-label={`${tank.code} ${tank.name}`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap border-l border-gray-100 px-3 py-3 text-[15px] ${alignClass(
                        col,
                      )} ${col.key === columns[0]?.key ? 'border-l-0 pl-6' : ''}`}
                    >
                      {renderCell(tank, col.key)}
                    </td>
                  ))}
                </tr>
              ))
            : tanks.flatMap((tank) => {
                // Cleaner fish: one row per batch, tank-level columns rowspan'd
                const batchCount = tank.cleanerFishDetails?.length || 0;
                const rowCount = Math.max(1, batchCount);

                return Array.from({ length: rowCount }, (_, batchIdx) => {
                  const isFirstRow = batchIdx === 0;
                  return (
                    <tr
                      key={`${tank.id}-${batchIdx}`}
                      onClick={() => onRowClick(tank)}
                      className={rowClasses(tank)}
                      aria-label={`${tank.code} ${tank.name}`}
                    >
                      {columns.map((col) => {
                        if (isTankLevelColumn(col.key)) {
                          if (!isFirstRow) return null;
                          return (
                            <td
                              key={col.key}
                              rowSpan={rowCount > 1 ? rowCount : undefined}
                              className={`whitespace-nowrap border-l border-gray-100 px-3 py-3 align-top text-[15px] ${alignClass(
                                col,
                              )} ${col.key === columns[0]?.key ? 'border-l-0 pl-6' : ''}`}
                            >
                              {renderCleanerTankCell(tank, col.key)}
                            </td>
                          );
                        }
                        return (
                          <td
                            key={col.key}
                            className={`whitespace-nowrap border-l border-gray-100 px-3 py-2 text-sm ${alignClass(
                              col,
                            )}`}
                          >
                            {batchCount === 0
                              ? '—'
                              : renderCleanerBatchCell(tank, col.key, batchIdx)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                });
              })}
        </tbody>
      </table>
    </div>
  );
};
