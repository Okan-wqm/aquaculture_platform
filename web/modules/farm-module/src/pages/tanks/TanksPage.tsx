/**
 * Tanks Page — /sites/tanks table view.
 *
 * Layout (design_handoff tenant console "Tanks"): the Üretim / Temizlikçi
 * balık view tabs, the unit/batch/feed search, ONE horizontal filter row
 * (site buttons · category buttons · Dolu/Boş), a result-count line, then
 * the dense unit table. Tank operations no longer live in a page-level
 * toolbar: clicking a row opens the right-side TankDetailDrawer which
 * carries the metrics grid, the density·capacity bar, live Sıcaklık/DO,
 * the feeding block, and the operation buttons (mortality, sampling,
 * transfer/split, grading, cull, water temperature, feeding plan — and
 * "stock this unit" for empty units).
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { useTanksList } from '../../hooks/useTanks';
import { useSpeciesList } from '../../hooks/useSpecies';
import { isBlockingError } from '../../utils/list-view-state';
import { TankWithBatch, tankToTankWithBatch, tankWithBatchToTankBatch } from './types';
import { tankColumns, cleanerFishColumns, cleanerFishColumnGroups } from './columns';
import { useColumnVisibility } from './useColumnVisibility';
import { ColumnVisibilityMenu } from './ColumnVisibilityMenu';
import { TankTable } from './components/TankTable';
import { TankDetailDrawer, type TankDetailVariant } from './components/TankDetailDrawer';
import { SamplingModal } from './components/SamplingModal';

// Quick-action disambiguation components (tank hosting both fish types)
import {
  FishTypeSelector,
  CleanerBatchSelector,
  OperationType,
  WaterTemperatureModal,
} from './components';

// Production operation modals
import { MortalityModal } from '../production/components/MortalityModal';
import { TransferModal } from '../production/components/TransferModal';
import { GradingModal } from '../production/components/GradingModal';
import { CullModal } from '../production/components/CullModal';
import { BatchFormModal } from '../production/components/BatchFormModal';

// Cleaner-fish modals
import { MortalityModal as CleanerMortalityModal } from '../cleaner-fish/components/MortalityModal';
import { TransferModal as CleanerTransferModal } from '../cleaner-fish/components/TransferModal';
import { CreateBatchModal } from '../cleaner-fish/components/CreateBatchModal';
import { DeployModal } from '../cleaner-fish/components/DeployModal';
import { RemoveModal } from '../cleaner-fish/components/RemoveModal';

import {
  CleanerFishBatch,
  useCleanerFishBatches,
  useCleanerFishSpecies,
} from '../../hooks/useCleanerFish';

// ============================================================================
// FILTER MODEL
// ============================================================================

type SiteFilter = string; // siteId, or '__none__' for units without a site
type CategoryFilter = 'all' | 'tank' | 'pond' | 'cage';
type OccupancyFilter = 'all' | 'occupied' | 'empty';

interface FilterState {
  search: string;
  siteId: SiteFilter; // 'all' | siteId
  category: CategoryFilter;
  occupancy: OccupancyFilter;
  status: string; // 'all' | tank status enum
}

const NO_SITE_KEY = '__none__';

const INITIAL_FILTERS: FilterState = {
  search: '',
  siteId: 'all',
  category: 'all',
  occupancy: 'all',
  status: 'all',
};

/** Tank statuses offered by the status filter (labels via tanksV2.status.*). */
const STATUS_OPTIONS = [
  'OPERATIONAL',
  'ACTIVE',
  'PREPARING',
  'MAINTENANCE',
  'CLEANING',
  'HARVESTING',
  'FALLOW',
  'QUARANTINE',
  'OUT_OF_SERVICE',
  'DECOMMISSIONED',
] as const;

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  OPERATIONAL: 'tanksV2.status.OPERATIONAL',
  ACTIVE: 'tanksV2.status.ACTIVE',
  PREPARING: 'tanksV2.status.PREPARING',
  MAINTENANCE: 'tanksV2.status.MAINTENANCE',
  CLEANING: 'tanksV2.status.CLEANING',
  HARVESTING: 'tanksV2.status.HARVESTING',
  FALLOW: 'tanksV2.status.FALLOW',
  QUARANTINE: 'tanksV2.status.QUARANTINE',
  OUT_OF_SERVICE: 'tanksV2.status.OUT_OF_SERVICE',
  DECOMMISSIONED: 'tanksV2.status.DECOMMISSIONED',
};

/** Ordered category → button label key (only present categories render). */
const CATEGORY_LABEL_KEYS: Record<Exclude<CategoryFilter, 'all'>, MessageKey> = {
  tank: 'tanksV2.filter.tanks',
  pond: 'tanksV2.filter.ponds',
  cage: 'tanksV2.filter.cages',
};

const CATEGORY_ORDER: Exclude<CategoryFilter, 'all'>[] = ['tank', 'pond', 'cage'];

interface SegButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

/** One button of the single-row filter bar (design `seg()` — square, filled active). */
const SegButton: React.FC<SegButtonProps> = ({ label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex min-h-[42px] shrink-0 items-center border px-3.5 text-[15.5px] font-medium transition-colors ${
      active
        ? 'border-blue-600 bg-blue-600 text-white'
        : 'border-gray-300 bg-transparent text-gray-700 hover:border-blue-400 hover:text-blue-700'
    }`}
  >
    {label}
  </button>
);

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const TanksPage: React.FC = () => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();

  // URL params for tab selection (supports redirect from /sites/cleaner-fish)
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'production' | 'cleanerFish'>(
    tabFromUrl === 'cleanerFish' ? 'cleanerFish' : 'production',
  );

  // ============================================================================
  // DATA
  // ============================================================================

  // Fetch ALL tanks with batch metrics — useTanksList pages through the backend
  // list (100/page) when no pagination is passed, so no container is invisible.
  const { data, isLoading: tanksLoading, error, refetch } = useTanksList({ isActive: true });

  // Species display names for the table / drawer batch lines
  // (localName → commonName → code)
  const { data: speciesData } = useSpeciesList({ isActive: true, limit: 100 });
  const speciesNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of speciesData?.items ?? []) {
      map[s.code] = s.localName || s.commonName || s.code;
    }
    return map;
  }, [speciesData]);

  // Cleaner fish data (management bar + deploy modal)
  const {
    data: cfBatches,
    isLoading: cfBatchesLoading,
    refetch: refetchCfBatches,
  } = useCleanerFishBatches();
  const { data: cfSpecies, isLoading: cfSpeciesLoading } = useCleanerFishSpecies();

  const isLoading =
    tanksLoading || (activeTab === 'cleanerFish' && (cfBatchesLoading || cfSpeciesLoading));

  const tableData: TankWithBatch[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map(tankToTankWithBatch);
  }, [data?.items]);

  const activeCfBatches = useMemo(() => {
    if (!cfBatches) return [];
    return cfBatches.filter((b) => b.currentQuantity > 0 && b.status === 'ACTIVE');
  }, [cfBatches]);

  // ============================================================================
  // FILTERS
  // ============================================================================

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Column visibility — production table (30-column model, 9 design defaults)
  const {
    visibleColumns,
    toggleColumn,
    toggleGroup,
    resetToDefaults,
    showAllColumns,
    isColumnVisible,
  } = useColumnVisibility();

  // Column visibility — cleaner-fish table (per-batch cf* columns)
  const {
    visibleColumns: cfVisibleColumns,
    toggleColumn: cfToggleColumn,
    toggleGroup: cfToggleGroup,
    resetToDefaults: cfResetToDefaults,
    showAllColumns: cfShowAllColumns,
    isColumnVisible: cfIsColumnVisible,
  } = useColumnVisibility('tanks-page-cf-column-visibility', cleanerFishColumns);

  // The active tab's visible columns, in model order
  const activeColumns = useMemo(() => {
    return activeTab === 'cleanerFish'
      ? cleanerFishColumns.filter((col) => cfIsColumnVisible(col.key))
      : tankColumns.filter((col) => isColumnVisible(col.key));
  }, [activeTab, cfIsColumnVisible, isColumnVisible]);

  const filteredData = useMemo(() => {
    const q = filters.search.toLowerCase();
    return tableData.filter((tank) => {
      const matchesSearch =
        q === '' ||
        tank.name.toLowerCase().includes(q) ||
        tank.code.toLowerCase().includes(q) ||
        (tank.batchNumber?.toLowerCase().includes(q) ?? false) ||
        (tank.speciesCode?.toLowerCase().includes(q) ?? false) ||
        (tank.feedName?.toLowerCase().includes(q) ?? false) ||
        (tank.feedCode?.toLowerCase().includes(q) ?? false);

      const matchesSite =
        filters.siteId === 'all' || (tank.siteId ?? NO_SITE_KEY) === filters.siteId;
      const matchesCategory = filters.category === 'all' || tank.category === filters.category;
      const stocked = !!(tank.batchNumber || tank.hasCleanerFish);
      const matchesOccupancy =
        filters.occupancy === 'all' || (filters.occupancy === 'occupied' ? stocked : !stocked);
      const matchesStatus = filters.status === 'all' || tank.status === filters.status;

      return matchesSearch && matchesSite && matchesCategory && matchesOccupancy && matchesStatus;
    });
  }, [tableData, filters]);

  // Site buttons — distinct sites present in the data
  const siteButtons = useMemo(() => {
    const labels = new Map<string, string>();
    for (const tank of tableData) {
      const key = tank.siteId ?? NO_SITE_KEY;
      if (!labels.has(key)) {
        labels.set(key, tank.siteName || tank.departmentName || t('tanksV2.filter.noSite'));
      }
    }
    return [...labels.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [tableData, t]);

  // Category buttons — only categories present in the data
  const categoryButtons = useMemo(() => {
    return CATEGORY_ORDER.filter((cat) => tableData.some((tank) => tank.category === cat));
  }, [tableData]);

  // Result-count line: "N birim · X kg" over the filtered rows
  const countLine = useMemo(() => {
    const biomass = filteredData.reduce((sum, tank) => sum + (tank.biomass ?? 0), 0);
    const numberLocale = locale === 'tr' ? 'tr-TR' : 'en-US';
    const biomassLabel =
      biomass >= 1000
        ? `${(biomass / 1000).toLocaleString(numberLocale, { maximumFractionDigits: 1 })} t`
        : `${biomass.toLocaleString(numberLocale, { maximumFractionDigits: biomass < 10 ? 2 : 0 })} kg`;
    return t('tanksV2.grid.count', {
      count: filteredData.length,
      biomass: biomassLabel,
    });
  }, [filteredData, locale, t]);

  const setFilter = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ============================================================================
  // TANK DETAIL DRAWER + OPERATION STATE
  // ============================================================================

  const [detailTankId, setDetailTankId] = useState<string | null>(null);
  const [showSamplingModal, setShowSamplingModal] = useState(false);

  // The unit the drawer (and any operation launched from it) acts on.
  const selectedTank = useMemo(() => {
    if (!detailTankId) return null;
    return tableData.find((tk) => tk.id === detailTankId) || null;
  }, [detailTankId, tableData]);

  // Modal visibility states
  const [showMortalityModal, setShowMortalityModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showCullModal, setShowCullModal] = useState(false);
  const [showGradingModal, setShowGradingModal] = useState(false);
  const [showWaterTempModal, setShowWaterTempModal] = useState(false);

  // Fish type selection (when tank has both production and cleaner fish)
  const [showFishTypeSelector, setShowFishTypeSelector] = useState(false);
  const [operationFishType, setOperationFishType] = useState<'production' | 'cleaner' | null>(null);
  const [pendingOperation, setPendingOperation] = useState<OperationType | null>(null);

  // Cleaner batch selection (when tank has multiple cleaner fish batches)
  const [showCleanerBatchSelector, setShowCleanerBatchSelector] = useState(false);
  const [selectedCleanerBatch, setSelectedCleanerBatch] = useState<CleanerFishBatch | null>(null);

  // Batch creation / cleaner-fish batch management
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showCreateBatchModal, setShowCreateBatchModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [removeBatchInfo, setRemoveBatchInfo] = useState<{
    batch: CleanerFishBatch;
    tankId: string;
  } | null>(null);

  /**
   * Minimal cleaner-batch shape built from a tank's cleanerFishDetails entry —
   * the cleaner-fish operation modals consume the CleanerFishBatch form.
   */
  const cleanerBatchFromDetail = useCallback(
    (detail: {
      batchId: string;
      batchNumber: string;
      speciesId: string;
      quantity: number;
      deployedAt: string;
    }): CleanerFishBatch => ({
      id: detail.batchId,
      batchNumber: detail.batchNumber,
      speciesId: detail.speciesId,
      initialQuantity: detail.quantity,
      currentQuantity: detail.quantity,
      stockedAt: detail.deployedAt,
      status: 'ACTIVE',
      isActive: true,
      createdAt: detail.deployedAt,
      updatedAt: detail.deployedAt,
    }),
    [],
  );

  /**
   * Route a mortality/transfer click from the drawer through the fish-type and
   * cleaner-batch disambiguation chain (same behaviour as the old toolbar).
   */
  const runTankOperation = useCallback(
    (operation: 'mortality' | 'transfer') => {
      if (!selectedTank) return;

      const hasProd = !!selectedTank.batchNumber;
      const hasCleaner = selectedTank.hasCleanerFish;

      if (hasProd && hasCleaner) {
        setPendingOperation(operation);
        setShowFishTypeSelector(true);
      } else if (hasProd) {
        setOperationFishType('production');
        if (operation === 'mortality') setShowMortalityModal(true);
        else setShowTransferModal(true);
      } else if (hasCleaner) {
        setOperationFishType('cleaner');
        if ((selectedTank.cleanerFishDetails?.length ?? 0) > 1) {
          setPendingOperation(operation);
          setShowCleanerBatchSelector(true);
        } else if (selectedTank.cleanerFishDetails?.[0]) {
          setSelectedCleanerBatch(cleanerBatchFromDetail(selectedTank.cleanerFishDetails[0]));
          if (operation === 'mortality') setShowMortalityModal(true);
          else setShowTransferModal(true);
        }
      }
    },
    [cleanerBatchFromDetail, selectedTank],
  );

  const handleMortalityClick = useCallback(() => runTankOperation('mortality'), [runTankOperation]);
  const handleTransferClick = useCallback(() => runTankOperation('transfer'), [runTankOperation]);

  const handleCullClick = useCallback(() => {
    if (selectedTank?.batchNumber) {
      setOperationFishType('production');
      setShowCullModal(true);
    }
  }, [selectedTank]);

  const handleGradingClick = useCallback(() => {
    if (selectedTank?.batchNumber) {
      setOperationFishType('production');
      setShowGradingModal(true);
    }
  }, [selectedTank]);

  const handleSamplingClick = useCallback(() => {
    if (selectedTank?.batchNumber) {
      setShowSamplingModal(true);
    }
  }, [selectedTank]);

  const handleWaterTempClick = useCallback(() => {
    if (selectedTank) setShowWaterTempModal(true);
  }, [selectedTank]);

  /** Besleme planını aç — the unit's feeding plan lives on /sites/feeding. */
  const handleOpenFeedingPlan = useCallback(() => {
    navigate('/sites/feeding');
  }, [navigate]);

  /** Boş birimi stokla — batch creation (with tank allocation) flow. */
  const handleStockUnit = useCallback(() => {
    setShowBatchModal(true);
  }, []);

  const handleFishTypeSelect = useCallback(
    (type: 'production' | 'cleaner') => {
      setShowFishTypeSelector(false);
      setOperationFishType(type);

      if (type === 'production') {
        if (pendingOperation === 'mortality') setShowMortalityModal(true);
        else if (pendingOperation === 'transfer') setShowTransferModal(true);
      } else if (type === 'cleaner' && selectedTank) {
        if ((selectedTank.cleanerFishDetails?.length ?? 0) > 1) {
          setShowCleanerBatchSelector(true);
        } else if (selectedTank.cleanerFishDetails?.[0]) {
          setSelectedCleanerBatch(cleanerBatchFromDetail(selectedTank.cleanerFishDetails[0]));
          if (pendingOperation === 'mortality') setShowMortalityModal(true);
          else if (pendingOperation === 'transfer') setShowTransferModal(true);
        }
      }
    },
    [cleanerBatchFromDetail, pendingOperation, selectedTank],
  );

  const handleCleanerBatchSelect = useCallback(
    (batch: {
      batchId: string;
      batchNumber: string;
      speciesId: string;
      speciesName: string;
      quantity: number;
      avgWeightG: number;
      biomassKg: number;
      sourceType: 'farmed' | 'wild_caught';
      deployedAt: string;
    }) => {
      setShowCleanerBatchSelector(false);
      setSelectedCleanerBatch(cleanerBatchFromDetail(batch));

      if (pendingOperation === 'mortality') setShowMortalityModal(true);
      else if (pendingOperation === 'transfer') setShowTransferModal(true);
    },
    [cleanerBatchFromDetail, pendingOperation],
  );

  /** Operation success — refetch and reset the operation chain; the drawer
   * stays open and re-renders with the refreshed metrics. */
  const handleOperationSuccess = useCallback(() => {
    refetch();
    setShowMortalityModal(false);
    setShowTransferModal(false);
    setShowCullModal(false);
    setShowGradingModal(false);
    setShowSamplingModal(false);
    setOperationFishType(null);
    setPendingOperation(null);
    setSelectedCleanerBatch(null);
  }, [refetch]);

  /** Sampling success — the drawer stays open; metrics refresh via refetch. */
  const handleSamplingSuccess = useCallback(() => {
    refetch();
    setShowSamplingModal(false);
  }, [refetch]);

  const handleWaterTempSuccess = useCallback(() => {
    setShowWaterTempModal(false);
    refetch();
  }, [refetch]);

  /** Close all operation modals (the drawer itself stays untouched). */
  const handleCloseModals = useCallback(() => {
    setShowMortalityModal(false);
    setShowTransferModal(false);
    setShowCullModal(false);
    setShowGradingModal(false);
    setShowSamplingModal(false);
    setShowWaterTempModal(false);
    setShowFishTypeSelector(false);
    setShowCleanerBatchSelector(false);
    setOperationFishType(null);
    setPendingOperation(null);
    setSelectedCleanerBatch(null);
  }, []);

  const handleRemoveFromTank = useCallback(
    (batchId: string) => {
      if (!detailTankId) return;
      const batch = cfBatches?.find((b) => b.id === batchId) || null;
      if (batch) {
        setRemoveBatchInfo({ batch, tankId: detailTankId });
        setShowRemoveModal(true);
      }
    },
    [cfBatches, detailTankId],
  );

  const handleCreateBatchSuccess = useCallback(() => {
    setShowCreateBatchModal(false);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  const handleDeploySuccess = useCallback(() => {
    setShowDeployModal(false);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  const handleRemoveSuccess = useCallback(() => {
    setShowRemoveModal(false);
    setRemoveBatchInfo(null);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  const switchTab = useCallback(
    (tab: 'production' | 'cleanerFish') => {
      setActiveTab(tab);
      setDetailTankId(null);
      // Keep the URL shareable: ?tab=cleanerFish round-trips through the
      // /sites/cleaner-fish redirect.
      const next = new URLSearchParams(searchParams);
      if (tab === 'cleanerFish') next.set('tab', 'cleanerFish');
      else next.delete('tab');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // ============================================================================
  // RENDER
  // ============================================================================

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="mb-4 flex gap-6">
            <div className="h-8 w-32 rounded bg-gray-200" />
            <div className="h-8 w-44 rounded bg-gray-200" />
          </div>
          <div className="mb-3 h-12 w-full max-w-[620px] bg-gray-200" />
          <div className="mb-3 flex gap-2">
            {[...Array(7)].map((_, i) => (
              <div key={i} className="h-[42px] w-28 bg-gray-200" />
            ))}
          </div>
          <div className="mb-4 h-5 w-48 bg-gray-200" />
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-200" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Blocking error state — ONLY when the initial load failed and there is no
  // cached data to show. A failed background refetch keeps the table visible
  // with a non-blocking banner instead of blanking the page.
  if (isBlockingError(error, data != null)) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h3 className="font-medium text-red-800">Error loading tanks</h3>
          <p className="mt-1 text-sm text-red-600">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 rounded bg-red-100 px-4 py-2 text-red-800 hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {error && (
        <div className="mb-4 flex items-center justify-between rounded border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh tanks — showing the last loaded data.{' '}
            <span className="text-amber-700">{(error as Error).message}</span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── View tabs: Üretim / Temizlikçi balık ── */}
      <div className="mb-4 flex items-end gap-6 border-b border-gray-200">
        <button
          type="button"
          onClick={() => switchTab('production')}
          className={`relative border-b-2 pb-2 text-xl font-semibold transition-colors ${
            activeTab === 'production'
              ? 'border-blue-600 text-blue-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {t('tanksV2.tab.production')}
          <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 align-middle text-xs font-medium text-blue-700">
            {tableData.filter((tk) => tk.batchNumber).length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => switchTab('cleanerFish')}
          className={`relative border-b-2 pb-2 text-xl font-semibold transition-colors ${
            activeTab === 'cleanerFish'
              ? 'border-green-600 text-green-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          {t('tanksV2.tab.cleanerFish')}
          <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 align-middle text-xs font-medium text-green-700">
            {tableData.filter((tk) => tk.hasCleanerFish).length}
          </span>
        </button>
      </div>

      {/* ── Search ── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 md:max-w-[620px]">
          <svg
            className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-4.34-4.34M11 3a8 8 0 100 16 8 8 0 100-16z"
            />
          </svg>
          <input
            type="search"
            placeholder={t('tanksV2.searchPlaceholder')}
            aria-label={t('tanksV2.searchPlaceholder')}
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            className="min-h-[50px] w-full border border-gray-300 py-2 pl-11 pr-4 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {activeTab === 'production' ? (
          <button
            type="button"
            onClick={() => setShowBatchModal(true)}
            className="inline-flex items-center gap-1.5 bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('tanksV2.newBatch')}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowCreateBatchModal(true)}
              className="inline-flex items-center gap-1.5 bg-green-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-green-700"
            >
              + {t('tanksV2.createBatch')}
            </button>
            <button
              type="button"
              onClick={() => setShowDeployModal(true)}
              disabled={activeCfBatches.length === 0}
              className="inline-flex items-center gap-1.5 bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('tanksV2.deployToTank')}
            </button>
          </>
        )}

        {activeTab === 'production' ? (
          <ColumnVisibilityMenu
            columns={tankColumns}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onToggleGroup={toggleGroup}
            onReset={resetToDefaults}
            onShowAll={showAllColumns}
          />
        ) : (
          <ColumnVisibilityMenu
            columns={cleanerFishColumns}
            visibleColumns={cfVisibleColumns}
            onToggle={cfToggleColumn}
            onToggleGroup={cfToggleGroup}
            onReset={cfResetToDefaults}
            onShowAll={cfShowAllColumns}
            groups={cleanerFishColumnGroups}
          />
        )}

        <button
          type="button"
          onClick={() => refetch()}
          title={t('tanksV2.filter.refresh')}
          className="rounded p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      {/* ── Single-row filter bar: sites · categories · occupancy ── */}
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div role="group" className="flex flex-wrap gap-1.5">
          <SegButton
            label={t('tanksV2.filter.allSites')}
            active={filters.siteId === 'all'}
            onClick={() => setFilter('siteId', 'all')}
          />
          {siteButtons.map((site) => (
            <SegButton
              key={site.key}
              label={site.label}
              active={filters.siteId === site.key}
              onClick={() => setFilter('siteId', site.key)}
            />
          ))}
        </div>

        {categoryButtons.length > 0 && (
          <div role="group" className="flex flex-wrap gap-1.5">
            <SegButton
              label={t('tanksV2.filter.all')}
              active={filters.category === 'all'}
              onClick={() => setFilter('category', 'all')}
            />
            {categoryButtons.map((category) => (
              <SegButton
                key={category}
                label={t(CATEGORY_LABEL_KEYS[category])}
                active={filters.category === category}
                onClick={() => setFilter('category', category)}
              />
            ))}
          </div>
        )}

        <div role="group" className="flex flex-wrap gap-1.5">
          <SegButton
            label={t('tanksV2.filter.all')}
            active={filters.occupancy === 'all'}
            onClick={() => setFilter('occupancy', 'all')}
          />
          <SegButton
            label={t('tanksV2.filter.occupied')}
            active={filters.occupancy === 'occupied'}
            onClick={() => setFilter('occupancy', 'occupied')}
          />
          <SegButton
            label={t('tanksV2.filter.empty')}
            active={filters.occupancy === 'empty'}
            onClick={() => setFilter('occupancy', 'empty')}
          />
        </div>

        {/* Status filter (legacy toolbar feature, kept in the same row) */}
        <select
          value={filters.status}
          onChange={(e) => setFilter('status', e.target.value)}
          aria-label={t('tanksV2.filter.status')}
          className="min-h-[42px] border border-gray-300 bg-white px-3 text-[15.5px] text-gray-700 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">{t('tanksV2.filter.allStatuses')}</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {t(STATUS_LABEL_KEYS[status])}
            </option>
          ))}
        </select>
      </div>

      {/* ── Result count ── */}
      <p className="mb-4 text-[15.5px] text-gray-600">{countLine}</p>

      {/* ── Unit table ── */}
      <TankTable
        tanks={filteredData}
        columns={activeColumns}
        speciesNames={speciesNames}
        variant={activeTab}
        selectedTankId={detailTankId}
        onRowClick={(tank) => setDetailTankId(tank.id)}
      />

      {/* ======================================================================== */}
      {/* MODALS & DRAWER                                                           */}
      {/* ======================================================================== */}

      {/* Tank detail drawer — the operations hub */}
      {selectedTank && (
        <TankDetailDrawer
          isOpen
          onClose={() => setDetailTankId(null)}
          tank={selectedTank}
          speciesName={
            selectedTank.speciesCode ? speciesNames[selectedTank.speciesCode] : undefined
          }
          variant={activeTab as TankDetailVariant}
          onMortality={handleMortalityClick}
          onSampling={handleSamplingClick}
          onTransfer={handleTransferClick}
          onGrading={handleGradingClick}
          onCull={handleCullClick}
          onWaterTemp={handleWaterTempClick}
          onOpenFeedingPlan={handleOpenFeedingPlan}
          onStockUnit={handleStockUnit}
          onRemoveCleanerBatch={handleRemoveFromTank}
        />
      )}

      {/* Fish Type Selector Modal (when tank has both production and cleaner fish) */}
      {showFishTypeSelector && selectedTank && pendingOperation && (
        <FishTypeSelector
          isOpen={showFishTypeSelector}
          onClose={handleCloseModals}
          onSelect={handleFishTypeSelect}
          tank={selectedTank}
          operation={pendingOperation}
        />
      )}

      {/* Cleaner Batch Selector Modal (when tank has multiple cleaner fish batches) */}
      {showCleanerBatchSelector && selectedTank && pendingOperation && (
        <CleanerBatchSelector
          isOpen={showCleanerBatchSelector}
          onClose={handleCloseModals}
          onSelect={handleCleanerBatchSelect}
          tank={selectedTank}
          operation={pendingOperation}
        />
      )}

      {/* Production operation modals */}
      {showMortalityModal && operationFishType === 'production' && selectedTank && (
        <MortalityModal
          isOpen={showMortalityModal}
          onClose={handleCloseModals}
          tank={tankWithBatchToTankBatch(selectedTank)}
          onSuccess={handleOperationSuccess}
        />
      )}

      {showTransferModal && operationFishType === 'production' && selectedTank && (
        <TransferModal
          isOpen={showTransferModal}
          onClose={handleCloseModals}
          tank={tankWithBatchToTankBatch(selectedTank)}
          onSuccess={handleOperationSuccess}
        />
      )}

      {showCullModal && operationFishType === 'production' && selectedTank && (
        <CullModal
          isOpen={showCullModal}
          onClose={handleCloseModals}
          tank={tankWithBatchToTankBatch(selectedTank)}
          onSuccess={handleOperationSuccess}
        />
      )}

      {showGradingModal && operationFishType === 'production' && selectedTank && (
        <GradingModal
          isOpen={showGradingModal}
          onClose={handleCloseModals}
          tank={tankWithBatchToTankBatch(selectedTank)}
          onSuccess={handleOperationSuccess}
        />
      )}

      {/* Tartım örneklemesi — growth sample for the drawer tank's batch */}
      {showSamplingModal && selectedTank && (
        <SamplingModal
          isOpen={showSamplingModal}
          onClose={() => setShowSamplingModal(false)}
          tank={selectedTank}
          onSuccess={handleSamplingSuccess}
        />
      )}

      {/* Record Water Temperature (tank-level — no batch/fish-type needed) */}
      {showWaterTempModal && selectedTank && (
        <WaterTemperatureModal
          isOpen={showWaterTempModal}
          onClose={() => setShowWaterTempModal(false)}
          tankId={selectedTank.id}
          tankName={selectedTank.name}
          onSuccess={handleWaterTempSuccess}
        />
      )}

      {/* Cleaner fish operation modals */}
      {showMortalityModal &&
        operationFishType === 'cleaner' &&
        selectedCleanerBatch &&
        detailTankId && (
          <CleanerMortalityModal
            isOpen={showMortalityModal}
            onClose={handleCloseModals}
            batch={selectedCleanerBatch}
            tankId={detailTankId}
            onSuccess={handleOperationSuccess}
          />
        )}

      {showTransferModal &&
        operationFishType === 'cleaner' &&
        selectedCleanerBatch &&
        detailTankId && (
          <CleanerTransferModal
            isOpen={showTransferModal}
            onClose={handleCloseModals}
            batch={selectedCleanerBatch}
            sourceTankId={detailTankId}
            tanks={tableData.map((tk) => ({
              id: tk.id,
              name: tk.name,
              code: tk.code,
            }))}
            onSuccess={handleOperationSuccess}
          />
        )}

      {/* Cleaner fish batch management modals */}
      <CreateBatchModal
        isOpen={showCreateBatchModal}
        onClose={() => setShowCreateBatchModal(false)}
        species={cfSpecies || []}
        onSuccess={handleCreateBatchSuccess}
      />

      <DeployModal
        isOpen={showDeployModal}
        onClose={() => setShowDeployModal(false)}
        batch={null}
        batches={activeCfBatches}
        tanks={tableData.map((tk) => ({
          id: tk.id,
          name: tk.name,
          code: tk.code,
        }))}
        onSuccess={handleDeploySuccess}
      />

      {removeBatchInfo && (
        <RemoveModal
          isOpen={showRemoveModal}
          onClose={() => {
            setShowRemoveModal(false);
            setRemoveBatchInfo(null);
          }}
          batch={removeBatchInfo.batch}
          tankId={removeBatchInfo.tankId}
          onSuccess={handleRemoveSuccess}
        />
      )}

      {/* Batch creation — header button and "stock this unit" both land here */}
      <BatchFormModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        onSuccess={() => {
          setShowBatchModal(false);
          refetch();
        }}
      />
    </div>
  );
};

export default TanksPage;
