/**
 * Tanks Page Component
 * Lists all tanks with their batch metrics
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useTanksList,
  tankStatusColors,
  tankTypeLabels,
  waterTypeLabels,
} from '../../hooks/useTanks';
import { isBlockingError } from '../../utils/list-view-state';
import {
  TankWithBatch,
  TankFilterState,
  initialFilterState,
  tankToTankWithBatch,
  tankWithBatchToTankBatch,
} from './types';
import { tankColumns, cleanerFishColumns } from './columns';
import { useColumnVisibility } from './useColumnVisibility';
import { ColumnVisibilityMenu } from './ColumnVisibilityMenu';

// Quick Actions Components
import {
  FishTypeSelector,
  CleanerBatchSelector,
  OperationType,
  WaterTemperatureModal,
} from './components';

// Production Modals
import { MortalityModal } from '../production/components/MortalityModal';
import { TransferModal } from '../production/components/TransferModal';
import { GradingModal } from '../production/components/GradingModal';
import { CullModal } from '../production/components/CullModal';
import { BatchFormModal } from '../production/components/BatchFormModal';

// Cleaner Fish Modals
import { MortalityModal as CleanerMortalityModal } from '../cleaner-fish/components/MortalityModal';
import { TransferModal as CleanerTransferModal } from '../cleaner-fish/components/TransferModal';
import { CreateBatchModal } from '../cleaner-fish/components/CreateBatchModal';
import { DeployModal } from '../cleaner-fish/components/DeployModal';
import { RemoveModal } from '../cleaner-fish/components/RemoveModal';

// Types
import {
  CleanerFishBatch,
  useCleanerFishBatches,
  useCleanerFishSpecies,
} from '../../hooks/useCleanerFish';

// ============================================================================
// STATUS COLORS
// ============================================================================

const statusColors: Record<string, string> = {
  OPERATIONAL: 'bg-green-100 text-green-800',
  ACTIVE: 'bg-green-100 text-green-800',
  PREPARING: 'bg-blue-100 text-blue-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  CLEANING: 'bg-cyan-100 text-cyan-800',
  HARVESTING: 'bg-purple-100 text-purple-800',
  FALLOW: 'bg-gray-100 text-gray-800',
  QUARANTINE: 'bg-red-100 text-red-800',
  OUT_OF_SERVICE: 'bg-gray-100 text-gray-800',
  DECOMMISSIONED: 'bg-gray-200 text-gray-600',
};

const categoryLabels: Record<string, string> = {
  tank: 'Tank',
  pond: 'Pond',
  cage: 'Cage',
  TANK: 'Tank',
  POND: 'Pond',
  CAGE: 'Cage',
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================


/**
 * Format date for display
 */
function formatDate(date: Date | string | undefined): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Format number with optional decimals
 */
function formatNumber(value: number | undefined, decimals = 1): string {
  if (value === undefined || value === null) return '-';
  return value.toLocaleString('tr-TR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const TanksPage: React.FC = () => {
  // URL params for tab selection (supports redirect from /sites/cleaner-fish)
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');

  // Tab state
  const [activeTab, setActiveTab] = useState<'production' | 'cleanerFish'>(
    tabFromUrl === 'cleanerFish' ? 'cleanerFish' : 'production',
  );

  // New Batch modal state
  const [showBatchModal, setShowBatchModal] = useState(false);

  // Filter state
  const [filters, setFilters] = useState<TankFilterState>(initialFilterState);

  // Column visibility (for production tab)
  const {
    visibleColumns,
    toggleColumn,
    toggleGroup,
    resetToDefaults,
    showAllColumns,
    isColumnVisible,
  } = useColumnVisibility();

  // Column visibility (for cleaner fish tab)
  const {
    visibleColumns: cfVisibleColumns,
    toggleColumn: cfToggleColumn,
    toggleGroup: cfToggleGroup,
    resetToDefaults: cfResetToDefaults,
    showAllColumns: cfShowAllColumns,
    isColumnVisible: cfIsColumnVisible,
  } = useColumnVisibility('tanks-page-cf-column-visibility', cleanerFishColumns);

  // Cleaner Fish Batch Management State
  const [showCreateBatchModal, setShowCreateBatchModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [selectedDeployBatch, setSelectedDeployBatch] = useState<CleanerFishBatch | null>(null);
  const [removeBatchInfo, setRemoveBatchInfo] = useState<{
    batch: CleanerFishBatch;
    tankId: string;
  } | null>(null);

  // Cleaner Fish Data Hooks
  const {
    data: cfBatches,
    isLoading: cfBatchesLoading,
    refetch: refetchCfBatches,
  } = useCleanerFishBatches();
  const { data: cfSpecies, isLoading: cfSpeciesLoading } = useCleanerFishSpecies();

  // Active cleaner fish batches (for deploy modal)
  const activeCfBatches = useMemo(() => {
    if (!cfBatches) return [];
    return cfBatches.filter((b) => b.currentQuantity > 0 && b.status === 'ACTIVE');
  }, [cfBatches]);

  // Fetch ALL tanks with batch metrics — useTanksList pages through the backend
  // list (100/page) when no pagination is passed, so no container is invisible.
  const { data, isLoading: tanksLoading, error, refetch } = useTanksList({ isActive: true });
  const isLoading =
    tanksLoading || (activeTab === 'cleanerFish' && (cfBatchesLoading || cfSpeciesLoading));

  // ============================================================================
  // QUICK ACTIONS STATE
  // ============================================================================

  // Selected tank for operations
  const [selectedTankId, setSelectedTankId] = useState<string | null>(null);

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

  // ============================================================================
  // DATA TRANSFORMATION
  // ============================================================================

  // Transform to TankWithBatch format
  const tableData: TankWithBatch[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map(tankToTankWithBatch);
  }, [data?.items]);

  // Selected tank object
  const selectedTank = useMemo(() => {
    if (!selectedTankId) return null;
    return tableData.find((t) => t.id === selectedTankId) || null;
  }, [selectedTankId, tableData]);

  // ============================================================================
  // QUICK ACTIONS HANDLERS
  // ============================================================================

  /**
   * Handle mortality button click
   */
  const handleMortalityClick = useCallback(() => {
    if (!selectedTankId || !selectedTank) return;

    const hasProd = !!selectedTank.batchNumber;
    const hasCleaner = selectedTank.hasCleanerFish;

    if (hasProd && hasCleaner) {
      // Show fish type selector
      setPendingOperation('mortality');
      setShowFishTypeSelector(true);
    } else if (hasProd) {
      setOperationFishType('production');
      setShowMortalityModal(true);
    } else if (hasCleaner) {
      setOperationFishType('cleaner');
      // If multiple cleaner batches, show batch selector
      if ((selectedTank.cleanerFishDetails?.length || 0) > 1) {
        setPendingOperation('mortality');
        setShowCleanerBatchSelector(true);
      } else if (selectedTank.cleanerFishDetails?.[0]) {
        // Single batch - convert to CleanerFishBatch format (minimal required fields)
        const detail = selectedTank.cleanerFishDetails[0];
        setSelectedCleanerBatch({
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
        });
        setShowMortalityModal(true);
      }
    }
  }, [selectedTankId, selectedTank]);

  /**
   * Handle transfer button click
   */
  const handleTransferClick = useCallback(() => {
    if (!selectedTankId || !selectedTank) return;

    const hasProd = !!selectedTank.batchNumber;
    const hasCleaner = selectedTank.hasCleanerFish;

    if (hasProd && hasCleaner) {
      // Show fish type selector
      setPendingOperation('transfer');
      setShowFishTypeSelector(true);
    } else if (hasProd) {
      setOperationFishType('production');
      setShowTransferModal(true);
    } else if (hasCleaner) {
      setOperationFishType('cleaner');
      // If multiple cleaner batches, show batch selector
      if ((selectedTank.cleanerFishDetails?.length || 0) > 1) {
        setPendingOperation('transfer');
        setShowCleanerBatchSelector(true);
      } else if (selectedTank.cleanerFishDetails?.[0]) {
        const detail = selectedTank.cleanerFishDetails[0];
        setSelectedCleanerBatch({
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
        });
        setShowTransferModal(true);
      }
    }
  }, [selectedTankId, selectedTank]);

  /**
   * Handle cull button click (production fish only)
   */
  const handleCullClick = useCallback(() => {
    if (!selectedTankId || !selectedTank) return;

    if (!selectedTank.batchNumber) {
      // No production fish to cull
      return;
    }

    setOperationFishType('production');
    setShowCullModal(true);
  }, [selectedTankId, selectedTank]);

  /**
   * Handle grading button click (production fish only)
   */
  const handleGradingClick = useCallback(() => {
    if (!selectedTankId || !selectedTank) return;

    if (!selectedTank.batchNumber) {
      // No production fish to grade
      return;
    }

    setOperationFishType('production');
    setShowGradingModal(true);
  }, [selectedTankId, selectedTank]);

  /**
   * Handle record-water-temperature button click.
   *
   * Water temperature applies to the tank itself (not a specific batch/fish
   * type), so unlike mortality/transfer this needs no production-vs-cleaner
   * disambiguation — it just opens the compact temperature modal for the
   * selected tank.
   */
  const handleWaterTempClick = useCallback(() => {
    if (!selectedTankId || !selectedTank) return;
    setShowWaterTempModal(true);
  }, [selectedTankId, selectedTank]);

  /**
   * Handle water-temperature save success — close the modal and refetch the
   * tanks list so the feed-rate columns (feedingRatePercent / dailyFeedKg)
   * recompute with the newly recorded temperature.
   */
  const handleWaterTempSuccess = useCallback(() => {
    setShowWaterTempModal(false);
    refetch();
  }, [refetch]);

  /**
   * Handle fish type selection (when tank has both types)
   */
  const handleFishTypeSelect = useCallback(
    (type: 'production' | 'cleaner') => {
      setShowFishTypeSelector(false);
      setOperationFishType(type);

      if (type === 'production') {
        if (pendingOperation === 'mortality') {
          setShowMortalityModal(true);
        } else if (pendingOperation === 'transfer') {
          setShowTransferModal(true);
        }
      } else if (type === 'cleaner' && selectedTank) {
        // Check if multiple cleaner batches
        if ((selectedTank.cleanerFishDetails?.length || 0) > 1) {
          setShowCleanerBatchSelector(true);
        } else if (selectedTank.cleanerFishDetails?.[0]) {
          const detail = selectedTank.cleanerFishDetails[0];
          setSelectedCleanerBatch({
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
          });
          if (pendingOperation === 'mortality') {
            setShowMortalityModal(true);
          } else if (pendingOperation === 'transfer') {
            setShowTransferModal(true);
          }
        }
      }
    },
    [pendingOperation, selectedTank],
  );

  /**
   * Handle cleaner batch selection
   */
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
      setSelectedCleanerBatch({
        id: batch.batchId,
        batchNumber: batch.batchNumber,
        speciesId: batch.speciesId,
        initialQuantity: batch.quantity,
        currentQuantity: batch.quantity,
        stockedAt: batch.deployedAt,
        status: 'ACTIVE',
        isActive: true,
        createdAt: batch.deployedAt,
        updatedAt: batch.deployedAt,
      });

      if (pendingOperation === 'mortality') {
        setShowMortalityModal(true);
      } else if (pendingOperation === 'transfer') {
        setShowTransferModal(true);
      }
    },
    [pendingOperation],
  );

  /**
   * Handle operation success - reset state and refetch
   */
  const handleOperationSuccess = useCallback(() => {
    refetch();
    setShowMortalityModal(false);
    setShowTransferModal(false);
    setShowCullModal(false);
    setShowGradingModal(false);
    setSelectedTankId(null);
    setOperationFishType(null);
    setPendingOperation(null);
    setSelectedCleanerBatch(null);
  }, [refetch]);

  /**
   * Close all modals and reset state
   */
  const handleCloseModals = useCallback(() => {
    setShowMortalityModal(false);
    setShowTransferModal(false);
    setShowCullModal(false);
    setShowGradingModal(false);
    setShowWaterTempModal(false);
    setShowFishTypeSelector(false);
    setShowCleanerBatchSelector(false);
    setOperationFishType(null);
    setPendingOperation(null);
    setSelectedCleanerBatch(null);
  }, []);

  // ============================================================================
  // CLEANER FISH BATCH MANAGEMENT HANDLERS
  // ============================================================================

  const handleCreateBatchSuccess = useCallback(() => {
    setShowCreateBatchModal(false);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  const handleDeploySuccess = useCallback(() => {
    setShowDeployModal(false);
    setSelectedDeployBatch(null);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  const handleRemoveFromTank = useCallback(
    (tankId: string, batchId: string) => {
      const batch = cfBatches?.find((b) => b.id === batchId) || null;
      if (batch) {
        setRemoveBatchInfo({ batch, tankId });
        setShowRemoveModal(true);
      }
    },
    [cfBatches],
  );

  const handleRemoveSuccess = useCallback(() => {
    setShowRemoveModal(false);
    setRemoveBatchInfo(null);
    refetchCfBatches();
    refetch();
  }, [refetchCfBatches, refetch]);

  // ============================================================================
  // FILTERING
  // ============================================================================

  // Apply filters
  const filteredData = useMemo(() => {
    return tableData.filter((tank) => {
      // Search filter
      const matchesSearch =
        filters.search === '' ||
        tank.name.toLowerCase().includes(filters.search.toLowerCase()) ||
        tank.code.toLowerCase().includes(filters.search.toLowerCase()) ||
        tank.batchNumber?.toLowerCase().includes(filters.search.toLowerCase());

      // Category filter (case-insensitive comparison)
      const matchesCategory =
        filters.category === 'all' ||
        tank.category.toUpperCase() === filters.category.toUpperCase();

      // Status filter
      const matchesStatus = filters.status === 'all' || tank.status === filters.status;

      // Department filter
      const matchesDepartment =
        filters.departmentId === 'all' || tank.departmentId === filters.departmentId;

      // Has batch filter
      const matchesHasBatch =
        filters.hasBatch === 'all' ||
        (filters.hasBatch === 'yes' && tank.batchNumber) ||
        (filters.hasBatch === 'no' && !tank.batchNumber);

      return (
        matchesSearch && matchesCategory && matchesStatus && matchesDepartment && matchesHasBatch
      );
    });
  }, [tableData, filters]);

  // Get active columns based on visibility (production tab)
  const activeColumns = useMemo(() => {
    return tankColumns.filter((col) => isColumnVisible(col.key));
  }, [isColumnVisible]);

  // Get active columns based on visibility (cleaner fish tab)
  const activeCleanerFishColumns = useMemo(() => {
    return cleanerFishColumns.filter((col) => cfIsColumnVisible(col.key));
  }, [cfIsColumnVisible]);

  // Handle filter change
  const handleFilterChange = useCallback((key: keyof TankFilterState, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Render cell value
  const renderCell = useCallback((tank: TankWithBatch, columnKey: string): React.ReactNode => {
    switch (columnKey) {
      case 'name':
        return <div className="font-medium text-gray-900">{tank.name}</div>;
      case 'code':
        return <span className="text-gray-600 font-mono text-sm">{tank.code}</span>;
      case 'category':
        return (
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              tank.category === 'pond'
                ? 'bg-blue-100 text-blue-800'
                : tank.category === 'cage'
                  ? 'bg-purple-100 text-purple-800'
                  : 'bg-cyan-100 text-cyan-800'
            }`}
          >
            {categoryLabels[tank.category] || tank.category}
          </span>
        );
      case 'status':
        return (
          <span
            className={`px-2 py-1 rounded-full text-xs font-medium ${
              statusColors[tank.status] || 'bg-gray-100 text-gray-800'
            }`}
          >
            {tank.status}
          </span>
        );
      case 'departmentName':
        return tank.departmentName || '-';
      case 'tankType':
        return tank.tankType || '-';
      case 'material':
        return tank.material || '-';
      case 'waterType':
        return tank.waterType || '-';
      case 'volume':
        return formatNumber(tank.volume, 1);
      case 'maxBiomass':
        return formatNumber(tank.maxBiomass, 0);
      case 'maxDensity':
        return formatNumber(tank.maxDensity, 1);
      case 'batchNumber': {
        // Combined batch (e.g. "B-1 + B-2") when several batches share the tank;
        // fall back to the single primary batch number otherwise.
        const details = tank.batchDetails;
        const batchLabel =
          details && details.length > 1
            ? details.map((d) => d.batchNumber).join(' + ')
            : tank.batchNumber;
        return batchLabel ? (
          <span className="text-blue-600 font-medium" title={batchLabel}>
            {batchLabel}
          </span>
        ) : (
          <span className="text-gray-400">-</span>
        );
      }
      case 'pieces':
        return formatNumber(tank.pieces, 0);
      case 'avgWeight':
        return formatNumber(tank.avgWeight, 1);
      case 'biomass':
        return formatNumber(tank.biomass, 1);
      case 'density':
        return tank.density !== undefined ? (
          <span
            className={`${
              tank.isOverCapacity
                ? 'text-red-600 font-bold'
                : tank.density > (tank.maxDensity || 30) * 0.9
                  ? 'text-yellow-600'
                  : 'text-gray-900'
            }`}
          >
            {formatNumber(tank.density, 1)}
          </span>
        ) : (
          '-'
        );
      case 'survivalRate':
        return tank.survivalRate !== undefined ? (
          <span
            className={`${
              tank.survivalRate >= 95
                ? 'text-green-600'
                : tank.survivalRate >= 90
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }`}
          >
            {formatNumber(tank.survivalRate, 1)}%
          </span>
        ) : (
          '-'
        );
      case 'mortalityRate':
        return tank.mortalityRate !== undefined ? (
          <span
            className={`${
              tank.mortalityRate <= 1
                ? 'text-green-600'
                : tank.mortalityRate <= 5
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }`}
          >
            {formatNumber(tank.mortalityRate, 2)}%
          </span>
        ) : (
          '-'
        );
      case 'fcr':
        return tank.fcr !== undefined ? (
          <span
            className={`${
              tank.fcr <= 1.2
                ? 'text-green-600'
                : tank.fcr <= 1.5
                  ? 'text-yellow-600'
                  : 'text-red-600'
            }`}
          >
            {formatNumber(tank.fcr, 2)}
          </span>
        ) : (
          '-'
        );
      case 'growthRate':
        return formatNumber(tank.growthRate, 2);
      case 'sgr':
        return tank.sgr !== undefined ? `${formatNumber(tank.sgr, 2)}%` : '-';
      case 'capacityUsedPercent':
        return tank.capacityUsedPercent !== undefined ? (
          <div className="flex items-center gap-2">
            <div className="w-16 bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full ${
                  tank.capacityUsedPercent > 100
                    ? 'bg-red-500'
                    : tank.capacityUsedPercent > 80
                      ? 'bg-yellow-500'
                      : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(tank.capacityUsedPercent, 100)}%` }}
              />
            </div>
            <span className="text-sm">{formatNumber(tank.capacityUsedPercent, 0)}%</span>
          </div>
        ) : (
          '-'
        );
      case 'daysSinceStocking':
        return formatNumber(tank.daysSinceStocking, 0);
      case 'lastFeedingAt':
        return formatDate(tank.lastFeedingAt);
      case 'lastSamplingAt':
        return formatDate(tank.lastSamplingAt);
      case 'projectedHarvestDate':
        return formatDate(tank.projectedHarvestDate);
      case 'speciesCode':
        return tank.speciesCode ? (
          <span className="font-medium text-gray-700">{tank.speciesCode}</span>
        ) : (
          <span className="text-gray-400">-</span>
        );
      case 'feedCode':
        return tank.feedCode ? (
          <span className="text-blue-600">{tank.feedCode}</span>
        ) : (
          <span className="text-gray-400">-</span>
        );
      case 'feedingRatePercent':
        return tank.feedingRatePercent !== undefined ? (
          <span>{formatNumber(tank.feedingRatePercent, 2)}%</span>
        ) : (
          '-'
        );
      case 'dailyFeedKg':
        return tank.dailyFeedKg !== undefined ? (
          <span className="font-medium">{formatNumber(tank.dailyFeedKg, 2)}</span>
        ) : (
          '-'
        );
      default:
        return '-';
    }
  }, []);

  // Render cleaner fish cell value for tank-level columns
  const renderCleanerFishTankCell = useCallback(
    (tank: TankWithBatch, columnKey: string): React.ReactNode => {
      switch (columnKey) {
        case 'name':
          return <div className="font-medium text-gray-900">{tank.name}</div>;
        case 'code':
          return <span className="text-gray-600 font-mono text-sm">{tank.code}</span>;
        case 'category':
          return (
            <span
              className={`px-2 py-1 rounded-full text-xs font-medium ${
                tank.category === 'pond'
                  ? 'bg-blue-100 text-blue-800'
                  : tank.category === 'cage'
                    ? 'bg-purple-100 text-purple-800'
                    : 'bg-cyan-100 text-cyan-800'
              }`}
            >
              {categoryLabels[tank.category] || tank.category}
            </span>
          );
        case 'status':
          return (
            <span
              className={`px-2 py-1 rounded-full text-xs font-medium ${
                statusColors[tank.status] || 'bg-gray-100 text-gray-800'
              }`}
            >
              {tank.status}
            </span>
          );
        case 'departmentName':
          return tank.departmentName || '-';
        case 'volume':
          return formatNumber(tank.volume, 1);
        default:
          return '-';
      }
    },
    [],
  );

  // Render cleaner fish cell value for batch-level columns (single batch)
  const renderCleanerFishBatchCell = useCallback(
    (tank: TankWithBatch, columnKey: string, batchIndex: number): React.ReactNode => {
      const cf = tank.cleanerFishDetails?.[batchIndex];
      if (!cf) return '-';

      switch (columnKey) {
        case 'cfSpecies':
          return <span className="text-sm">{cf.speciesName}</span>;

        case 'cfQuantity':
          return <span className="text-sm">{formatNumber(cf.quantity, 0)}</span>;

        case 'cfAvgWeight':
          return <span className="text-sm">{formatNumber(cf.avgWeightG, 1)}</span>;

        case 'cfBiomass':
          return <span className="text-sm">{formatNumber(cf.biomassKg, 2)}</span>;

        case 'cfSourceType':
          return (
            <span
              className={`px-1.5 py-0.5 rounded text-xs ${
                cf.sourceType === 'farmed'
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
            >
              {cf.sourceType === 'farmed' ? 'Farmed' : 'Wild'}
            </span>
          );

        case 'cfDeployedAt':
          return <span className="text-sm">{formatDate(new Date(cf.deployedAt))}</span>;

        case 'cfBatchNumber':
          return <span className="text-sm font-mono">{cf.batchNumber}</span>;

        case 'cfBatchCount':
          // Only show on first row
          if (batchIndex === 0) {
            return formatNumber(tank.cleanerFishDetails?.length || 0, 0);
          }
          return null;

        // Mortality tracking columns
        case 'cfInitialQuantity':
          return <span className="text-sm">{formatNumber(cf.initialQuantity, 0)}</span>;

        case 'cfTotalMortality':
          return cf.totalMortality ? (
            <span className="text-sm text-red-600 font-medium">
              {formatNumber(cf.totalMortality, 0)}
            </span>
          ) : (
            <span className="text-sm text-gray-400">0</span>
          );

        case 'cfMortalityRate':
          return cf.mortalityRate !== undefined ? (
            <span
              className={`text-sm ${
                cf.mortalityRate <= 1
                  ? 'text-green-600'
                  : cf.mortalityRate <= 5
                    ? 'text-yellow-600'
                    : 'text-red-600'
              }`}
            >
              {formatNumber(cf.mortalityRate, 2)}%
            </span>
          ) : (
            <span className="text-sm text-gray-400">0%</span>
          );

        case 'cfLastMortalityAt':
          return cf.lastMortalityAt ? (
            <span className="text-sm">{formatDate(new Date(cf.lastMortalityAt))}</span>
          ) : (
            <span className="text-sm text-gray-400">-</span>
          );

        case 'cfSurvivalRate':
          if (cf.initialQuantity && cf.initialQuantity > 0) {
            const survivalRate = (cf.quantity / cf.initialQuantity) * 100;
            return (
              <span
                className={`text-sm ${
                  survivalRate >= 95
                    ? 'text-green-600'
                    : survivalRate >= 90
                      ? 'text-yellow-600'
                      : 'text-red-600'
                }`}
              >
                {formatNumber(survivalRate, 1)}%
              </span>
            );
          }
          return <span className="text-sm text-gray-400">-</span>;

        default:
          return '-';
      }
    },
    [],
  );

  // Check if column is tank-level (not cleaner fish specific)
  const isTankLevelColumn = useCallback((columnKey: string): boolean => {
    return !columnKey.startsWith('cf');
  }, []);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-48 mb-4" />
          <div className="h-4 bg-gray-200 rounded w-96 mb-6" />
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-200 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Blocking error state — ONLY when the initial load failed and there is no
  // cached data to show. If a background refetch fails but we already have data,
  // we keep rendering it (stale-on-error) and surface a non-blocking banner in
  // the main view below instead of blanking the page.
  if (isBlockingError(error, data != null)) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <h3 className="text-red-800 font-medium">Error loading tanks</h3>
          <p className="text-red-600 text-sm mt-1">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-100 text-red-800 rounded-lg hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Non-blocking refresh error — shown while keeping the last-loaded data
          visible, so a failed background refetch never blanks the table. */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh tanks — showing the last loaded data.{' '}
            <span className="text-amber-700">{(error as Error).message}</span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Page Header with Quick Actions */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tanks, Ponds & Cages</h1>
          <p className="text-sm text-gray-500 mt-1">
            View all tanks, ponds and sea cages with their current batch metrics
          </p>
        </div>

        {/* Quick Actions - Top Right */}
        <div className="flex items-center gap-2 bg-gray-50 rounded-lg p-2 border border-gray-200">
          <select
            value={selectedTankId || ''}
            onChange={(e) => setSelectedTankId(e.target.value || null)}
            className="px-2 py-1.5 border border-gray-300 rounded text-sm min-w-[160px] bg-white focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select Tank...</option>
            {tableData
              .filter((t) => t.batchNumber || t.hasCleanerFish)
              .map((tank) => (
                <option key={tank.id} value={tank.id}>
                  {tank.name} {tank.hasCleanerFish ? '🐟' : ''}
                </option>
              ))}
          </select>

          <div className="h-6 w-px bg-gray-300" />

          <button
            onClick={handleMortalityClick}
            disabled={!selectedTankId}
            className="p-1.5 text-red-600 hover:bg-red-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Record Mortality"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </button>

          <button
            onClick={handleTransferClick}
            disabled={!selectedTankId}
            className="p-1.5 text-blue-600 hover:bg-blue-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Transfer Fish"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
          </button>

          <button
            onClick={handleCullClick}
            disabled={!selectedTankId || !selectedTank?.batchNumber}
            className="p-1.5 text-orange-600 hover:bg-orange-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Record Cull"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
              />
            </svg>
          </button>

          <button
            onClick={handleGradingClick}
            disabled={!selectedTankId || !selectedTank?.batchNumber}
            className="p-1.5 text-purple-600 hover:bg-purple-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Grade Fish"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4h18M7 8h10M10 12h4m-6 4h8m-5 4h2"
              />
            </svg>
          </button>

          <button
            onClick={handleWaterTempClick}
            disabled={!selectedTankId}
            className="p-1.5 text-cyan-600 hover:bg-cyan-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Record Water Temperature"
          >
            {/* Water-drop icon — records the manual water temperature the feed-rate uses */}
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"
              />
            </svg>
          </button>

          <div className="h-6 w-px bg-gray-300" />

          <button
            onClick={() => setShowBatchModal(true)}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded"
            title="New Batch"
          >
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Batch
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-4 mb-6 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search tanks..."
            value={filters.search}
            onChange={(e) => handleFilterChange('search', e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        {/* Category Filter */}
        <select
          value={filters.category}
          onChange={(e) => handleFilterChange('category', e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="all">All Categories</option>
          <option value="TANK">Tanks</option>
          <option value="POND">Ponds</option>
          <option value="CAGE">Cages</option>
        </select>

        {/* Status Filter */}
        <select
          value={filters.status}
          onChange={(e) => handleFilterChange('status', e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="all">All Status</option>
          <option value="ACTIVE">Active</option>
          <option value="OPERATIONAL">Operational</option>
          <option value="PREPARING">Preparing</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="FALLOW">Fallow</option>
          <option value="CLEANING">Cleaning</option>
          <option value="HARVESTING">Harvesting</option>
          <option value="QUARANTINE">Quarantine</option>
        </select>

        {/* Has Batch Filter */}
        <select
          value={filters.hasBatch}
          onChange={(e) => handleFilterChange('hasBatch', e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="all">All</option>
          <option value="yes">With Batch</option>
          <option value="no">Empty</option>
        </select>

        {/* Column Visibility Menu */}
        {activeTab === 'production' ? (
          <ColumnVisibilityMenu
            columns={tankColumns}
            visibleColumns={visibleColumns}
            onToggle={toggleColumn}
            onToggleGroup={toggleGroup}
            onReset={resetToDefaults}
            onShowAll={showAllColumns}
          />
        ) : activeTab === 'cleanerFish' ? (
          <ColumnVisibilityMenu
            columns={cleanerFishColumns}
            visibleColumns={cfVisibleColumns}
            onToggle={cfToggleColumn}
            onToggleGroup={cfToggleGroup}
            onReset={cfResetToDefaults}
            onShowAll={cfShowAllColumns}
          />
        ) : null}

        {/* Refresh Button */}
        <button
          onClick={() => refetch()}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
          title="Refresh"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6">
        <button
          onClick={() => setActiveTab('production')}
          className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
            activeTab === 'production'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          Production Batches
          <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">
            {filteredData.filter((t) => t.batchNumber).length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('cleanerFish')}
          className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
            activeTab === 'cleanerFish'
              ? 'border-green-500 text-green-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          Cleaner Fish
          <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">
            {filteredData.filter((t) => t.hasCleanerFish).length}
          </span>
        </button>
      </div>

      {/* Data Table - Production Tab */}
      {activeTab === 'production' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {activeColumns.map((col) => (
                    <th
                      key={col.key}
                      className={`px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider ${
                        col.align === 'right'
                          ? 'text-right'
                          : col.align === 'center'
                            ? 'text-center'
                            : 'text-left'
                      }`}
                    >
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredData.length === 0 ? (
                  <tr>
                    <td
                      colSpan={activeColumns.length}
                      className="px-4 py-12 text-center text-gray-500"
                    >
                      No tanks or ponds found
                    </td>
                  </tr>
                ) : (
                  filteredData.map((tank) => (
                    <tr key={tank.id} className="hover:bg-gray-50">
                      {activeColumns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-4 py-3 whitespace-nowrap text-sm ${
                            col.align === 'right'
                              ? 'text-right'
                              : col.align === 'center'
                                ? 'text-center'
                                : 'text-left'
                          }`}
                        >
                          {renderCell(tank, col.key)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Data Table - Cleaner Fish Tab with Rowspan */}
      {activeTab === 'cleanerFish' && (
        <>
          {/* Cleaner Fish Action Bar */}
          <div className="flex items-center justify-between mb-4 bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium text-green-800">
                {activeCfBatches.length} active batch{activeCfBatches.length !== 1 ? 'es' : ''}
                {' · '}
                {filteredData.filter((t) => t.hasCleanerFish).length} tanks with cleaner fish
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCreateBatchModal(true)}
                className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                Create Batch
              </button>
              <button
                onClick={() => setShowDeployModal(true)}
                disabled={activeCfBatches.length === 0}
                className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
                Deploy to Tank
              </button>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {activeCleanerFishColumns.map((col) => (
                      <th
                        key={col.key}
                        className={`px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider ${
                          col.align === 'right'
                            ? 'text-right'
                            : col.align === 'center'
                              ? 'text-center'
                              : 'text-left'
                        }`}
                      >
                        {col.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredData.length === 0 ? (
                    <tr>
                      <td
                        colSpan={activeCleanerFishColumns.length}
                        className="px-4 py-12 text-center text-gray-500"
                      >
                        No tanks or ponds found
                      </td>
                    </tr>
                  ) : (
                    filteredData.flatMap((tank) => {
                      // Determine number of rows for this tank
                      const batchCount = tank.cleanerFishDetails?.length || 0;
                      const rowCount = Math.max(1, batchCount);

                      // Generate rows for each cleaner fish batch (or 1 row if none)
                      return Array.from({ length: rowCount }, (_, batchIdx) => {
                        const isFirstRow = batchIdx === 0;
                        const rowKey = `${tank.id}-${batchIdx}`;

                        return (
                          <tr
                            key={rowKey}
                            className={`hover:bg-gray-50 ${
                              !isFirstRow ? 'border-t border-gray-100' : ''
                            } ${batchIdx === rowCount - 1 ? 'border-b border-gray-200' : ''}`}
                          >
                            {activeCleanerFishColumns.map((col) => {
                              // Tank-level columns: only render on first row with rowSpan
                              if (isTankLevelColumn(col.key)) {
                                if (!isFirstRow) {
                                  // Skip - already rendered with rowSpan
                                  return null;
                                }
                                return (
                                  <td
                                    key={col.key}
                                    rowSpan={rowCount > 1 ? rowCount : undefined}
                                    className={`px-4 py-3 whitespace-nowrap text-sm align-top ${
                                      col.align === 'right'
                                        ? 'text-right'
                                        : col.align === 'center'
                                          ? 'text-center'
                                          : 'text-left'
                                    } ${rowCount > 1 ? 'bg-gray-50/50 border-r border-gray-100' : ''}`}
                                  >
                                    {renderCleanerFishTankCell(tank, col.key)}
                                  </td>
                                );
                              }

                              // Batch-level columns: render for each batch
                              return (
                                <td
                                  key={col.key}
                                  className={`px-4 py-2 whitespace-nowrap text-sm ${
                                    col.align === 'right'
                                      ? 'text-right'
                                      : col.align === 'center'
                                        ? 'text-center'
                                        : 'text-left'
                                  }`}
                                >
                                  {batchCount === 0
                                    ? '-'
                                    : renderCleanerFishBatchCell(tank, col.key, batchIdx)}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      });
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Footer Info */}
      <div className="mt-4 text-sm text-gray-500 text-right">
        Showing {filteredData.length} of {tableData.length} tanks/ponds
        {' | '}
        {activeTab === 'production' ? (
          <>
            {visibleColumns.size} of {tankColumns.length} columns visible
          </>
        ) : activeTab === 'cleanerFish' ? (
          <>
            {cfVisibleColumns.size} of {cleanerFishColumns.length} columns visible
          </>
        ) : null}
      </div>

      {/* ======================================================================== */}
      {/* MODALS                                                                   */}
      {/* ======================================================================== */}

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

      {/* Production Fish Modals */}
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

      {/* Cleaner Fish Modals */}
      {showMortalityModal &&
        operationFishType === 'cleaner' &&
        selectedCleanerBatch &&
        selectedTankId && (
          <CleanerMortalityModal
            isOpen={showMortalityModal}
            onClose={handleCloseModals}
            batch={selectedCleanerBatch}
            tankId={selectedTankId}
            onSuccess={handleOperationSuccess}
          />
        )}

      {showTransferModal &&
        operationFishType === 'cleaner' &&
        selectedCleanerBatch &&
        selectedTankId && (
          <CleanerTransferModal
            isOpen={showTransferModal}
            onClose={handleCloseModals}
            batch={selectedCleanerBatch}
            sourceTankId={selectedTankId}
            tanks={tableData.map((t) => ({
              id: t.id,
              name: t.name,
              code: t.code,
            }))}
            onSuccess={handleOperationSuccess}
          />
        )}

      {/* Cleaner Fish Batch Management Modals */}
      <CreateBatchModal
        isOpen={showCreateBatchModal}
        onClose={() => setShowCreateBatchModal(false)}
        species={cfSpecies || []}
        onSuccess={handleCreateBatchSuccess}
      />

      <DeployModal
        isOpen={showDeployModal}
        onClose={() => {
          setShowDeployModal(false);
          setSelectedDeployBatch(null);
        }}
        batch={selectedDeployBatch}
        batches={activeCfBatches}
        tanks={tableData.map((t) => ({
          id: t.id,
          name: t.name,
          code: t.code,
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

      {/* New Batch Modal */}
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
