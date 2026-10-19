/**
 * Tank Table — the /sites/tanks unit list, column-driven.
 *
 * Design reference: design_handoff tenant console "Tanks" — a dense table
 * whose DEFAULT nine columns are Unit (code + department · site) · Batch
 * (batch + species) · Fish · Avg weight · Biomass · Density with capacity
 * bar · FCR · Survival · Last fed. The full model carries 30 selectable
 * columns (tanksV2.col.*) through the column-visibility menu; the
 * cleaner-fish tab renders the cf* per-batch columns (one row per batch;
 * the drawer keeps the batch grouping). Rendered through the shared
 * DataTable (FE-HIGH-069); row click opens the detail drawer, the selected
 * row is highlighted and over-capacity rows carry the warning tint.
 */
import React from 'react';
import { useI18n, DataTable, type DataTableColumn, type MessageKey } from '@aquaculture/shared-ui';
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

/** One cleaner-fish row: a tank paired with one of its batches (or none). */
interface CleanerRow {
  tank: TankWithBatch;
  batchIndex: number;
}

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
      <div className="border border-gray-200 bg-white px-4 py-10 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
        {t('tanksV2.grid.noResults')}
      </div>
    );
  }

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
        <div className="h-2 border border-gray-300 dark:border-gray-600">
          <div
            className={`h-full ${tank.isOverCapacity ? 'bg-warning-500' : 'bg-accent-600'}`}
            style={{ width: `${cap ?? 0}%` }}
          />
        </div>
      </div>
    );
  };

  /** Unit cell — big code + department · site subline (design). */
  const renderUnitCell = (tank: TankWithBatch): React.ReactNode => (
    <div>
      <div className="text-lg font-semibold leading-tight text-gray-900 dark:text-gray-100">
        {tank.code}
      </div>
      <div className="whitespace-nowrap text-[13px] text-gray-500 dark:text-gray-400">
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
        return <span className="font-medium text-gray-900 dark:text-gray-100">{tank.name}</span>;
      case 'batchNumber': {
        const label = batchLabel(tank);
        const species = speciesLabel(tank);
        return label ? (
          <div>
            <div className="whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
              {label}
            </div>
            {species && (
              <div className="text-[13px] text-gray-500 dark:text-gray-400">{species}</div>
            )}
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

  /** Cleaner-fish tank-level cell renderer. */
  const renderCleanerTankCell = (tank: TankWithBatch, key: string): React.ReactNode => {
    switch (key) {
      case 'code':
        return renderUnitCell(tank);
      case 'name':
        return <span className="font-medium text-gray-900 dark:text-gray-100">{tank.name}</span>;
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
        return fmt(tank.cleanerFishDetails?.length || 0, 0);
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
    if (selected) return 'bg-accent-50 dark:bg-accent-900/30';
    if (over) return 'bg-warning-50 dark:bg-warning-900/20';
    return '';
  };

  type Row = TankWithBatch | CleanerRow;
  const tableColumns: DataTableColumn<Row>[] = columns.map((col) => ({
    key: col.key,
    header: t(col.header),
    align: col.align,
    render: (_value, row) => {
      if ('tank' in row) {
        if (isTankLevelColumn(col.key)) {
          return renderCleanerTankCell(row.tank, col.key);
        }
        return renderCleanerBatchCell(row.tank, col.key, row.batchIndex);
      }
      return renderCell(row, col.key);
    },
  }));

  // Cleaner fish: flatten to one row per batch so the shared DataTable can
  // render the per-batch cf* columns (the drawer keeps the batch grouping).
  const rows: Row[] =
    variant === 'production'
      ? [...tanks]
      : tanks.flatMap((tank) => {
          const batchCount = tank.cleanerFishDetails?.length ?? 0;
          if (batchCount === 0) return [{ tank, batchIndex: 0 }];
          return Array.from({ length: batchCount }, (_, i) => ({ tank, batchIndex: i }));
        });

  return (
    <div className="overflow-x-auto border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      {/* key: DataTable's internal visible-column set is initialised once per
          mount, so any change to the visible column SET (tab switch, column
          menu toggle) must remount it to take effect. */}
      <DataTable<Row>
        key={columns.map((col) => col.key).join('|')}
        data={rows}
        columns={tableColumns}
        keyExtractor={(row) => ('tank' in row ? `${row.tank.id}-${row.batchIndex}` : row.id)}
        onRowClick={(row) => onRowClick('tank' in row ? row.tank : row)}
        rowClassName={(row) => rowClasses('tank' in row ? row.tank : row)}
        emptyMessage={t('tanksV2.grid.noResults')}
        searchable={false}
        sortable={false}
        stickyHeader={false}
        hoverable
        bordered={false}
        compact
      />
    </div>
  );
};
