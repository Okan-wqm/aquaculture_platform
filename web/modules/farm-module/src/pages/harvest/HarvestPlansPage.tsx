/**
 * HarvestPlansPage
 *
 * Comprehensive harvest plan management page with:
 * - List view with filtering (status, harvest type, date range, batch)
 * - Stats cards (draft, planned, scheduled, in progress, completed)
 * - Plan cards showing key info (plan code, batch, dates, estimates)
 * - Status badges with workflow actions
 * - Kanban-style or table view option
 * - Create/Edit form with all plan fields
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
  Modal,
  formatCurrency as sharedFormatCurrency,
  DEFAULT_CURRENCY,
} from '@aquaculture/shared-ui';
import {
  useHarvestPlanList,
  useHarvestPlanStats,
  useCreateHarvestPlan,
  useUpdateHarvestPlan,
  useDeleteHarvestPlan,
  useApproveHarvestPlan,
  useScheduleHarvestPlan,
  useStartHarvestPlan,
  useCompleteHarvestPlan,
  useCancelHarvestPlan,
  usePostponeHarvestPlan,
  type CreateHarvestPlanInput,
  type UpdateHarvestPlanInput,
  type HarvestPlanFilterInput,
} from '../../hooks/useHarvestPlans';
import { useBatchList } from '../../hooks/useBatches';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit,
  Filter,
  Grid,
  List,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  AlertTriangle,
  CheckCircle,
  FileText,
  Package,
  Scale,
  TrendingUp,
  DollarSign,
  Truck,
  Users,
  Target,
  ArrowRight,
  XCircle,
} from 'lucide-react';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

type HarvestPlanStatus =
  | 'draft'
  | 'planned'
  | 'approved'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'postponed';

type HarvestType = 'full' | 'partial' | 'selective' | 'emergency' | 'thinning';

type HarvestMethod = 'net' | 'pump' | 'drain' | 'manual' | 'crowder';

type ProductForm =
  | 'live'
  | 'fresh_whole'
  | 'fresh_gutted'
  | 'frozen_whole'
  | 'frozen_gutted'
  | 'fillet'
  | 'processed';

interface HarvestCriteria {
  targetWeight: {
    min: number;
    max: number;
    target: number;
  };
  targetQuantity?: {
    value: number;
    unit: 'pieces' | 'kg' | 'percent';
  };
  qualityGrade?: string;
  minimumConditionFactor?: number;
}

interface HarvestEstimates {
  estimatedQuantity: number;
  estimatedBiomass: number;
  estimatedAvgWeight: number;
  estimatedYield: number;
  confidenceLevel: 'low' | 'medium' | 'high';
  basedOnMeasurementDate?: string;
}

interface FinancialProjection {
  estimatedRevenue: number;
  estimatedPrice: number;
  priceUnit: 'per_kg' | 'per_piece';
  estimatedCost: number;
  estimatedProfit: number;
  margin: number;
  currency: string;
}

interface LogisticsPlan {
  harvestStartTime?: string;
  expectedDuration?: number;
  requiredEquipment?: string[];
  requiredPersonnel?: number;
  transportType?: 'truck' | 'boat' | 'container';
  transportCapacity?: number;
  destinationType?: 'processing' | 'market' | 'direct_sale' | 'export';
  destinationAddress?: string;
  coldChainRequired?: boolean;
}

interface CustomerOrder {
  customerId?: string;
  customerName?: string;
  orderId?: string;
  orderQuantity?: number;
  orderUnit?: string;
  deliveryDate?: string;
  contractPrice?: number;
}

interface QualityRequirements {
  certifications?: string[];
  sizeGrading?: boolean;
  qualityInspection?: boolean;
  traceabilityRequired?: boolean;
  specificRequirements?: string[];
}

interface HarvestPlan {
  id: string;
  tenantId: string;
  planCode: string;
  name: string;
  description?: string;
  batchId: string;
  batchNumber?: string;
  status: HarvestPlanStatus;
  harvestType: HarvestType;
  plannedDate: string;
  confirmedDate?: string;
  windowStartDate?: string;
  windowEndDate?: string;
  criteria: HarvestCriteria;
  harvestMethod?: HarvestMethod;
  productForm: ProductForm;
  estimates: HarvestEstimates;
  financialProjection?: FinancialProjection;
  logistics?: LogisticsPlan;
  customerOrder?: CustomerOrder;
  qualityRequirements?: QualityRequirements;
  actualQuantityHarvested?: number;
  actualBiomassHarvested?: number;
  actualAvgWeight?: number;
  approvedBy?: string;
  approvedAt?: string;
  createdBy: string;
  notes?: string;
  attachments?: string[];
  createdAt: string;
  updatedAt: string;
  // Computed fields from resolver
  daysUntilHarvest?: number;
  isWithinWindow?: boolean;
  isHarvestAllowed?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canApprove?: boolean;
  canSchedule?: boolean;
  canStartHarvest?: boolean;
  canComplete?: boolean;
  isOverdue?: boolean;
  estimatedRevenue?: number;
  estimatedProfit?: number;
  customerName?: string;
}

interface HarvestPlanStats {
  total: number;
  draft: number;
  planned: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  postponed: number;
  totalEstimatedBiomass: number;
  totalActualBiomass: number;
  upcomingCount: number;
  overdueCount: number;
}

interface FilterState {
  searchText: string;
  status: HarvestPlanStatus | '';
  harvestType: HarvestType | '';
  batchId: string;
  plannedDateFrom: string;
  plannedDateTo: string;
  activeOnly: boolean;
  overdueOnly: boolean;
}

type ViewMode = 'table' | 'kanban' | 'cards';

// ============================================================================
// MOCK DATA (kept for fallback reference, no longer used by component)
// ============================================================================

const _mockBatches = [
  { id: 'batch-1', batchNumber: 'B-2024-001', name: 'Sea Bass Batch A' },
  { id: 'batch-2', batchNumber: 'B-2024-002', name: 'Sea Bream Batch B' },
  { id: 'batch-3', batchNumber: 'B-2024-003', name: 'Trout Batch C' },
];

const _mockHarvestPlans: HarvestPlan[] = [
  {
    id: 'hp-1',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00001',
    name: 'Full Harvest - Sea Bass Batch A',
    description: 'Complete harvest of Sea Bass Batch A for market delivery',
    batchId: 'batch-1',
    batchNumber: 'B-2024-001',
    status: 'scheduled',
    harvestType: 'full',
    plannedDate: '2024-03-15',
    confirmedDate: '2024-03-15',
    windowStartDate: '2024-03-14',
    windowEndDate: '2024-03-16',
    criteria: {
      targetWeight: { min: 350, max: 450, target: 400 },
      targetQuantity: { value: 10000, unit: 'pieces' },
      qualityGrade: 'A',
    },
    harvestMethod: 'net',
    productForm: 'fresh_whole',
    estimates: {
      estimatedQuantity: 10000,
      estimatedBiomass: 4000,
      estimatedAvgWeight: 400,
      estimatedYield: 85,
      confidenceLevel: 'high',
    },
    financialProjection: {
      estimatedRevenue: 48000,
      estimatedPrice: 12,
      priceUnit: 'per_kg',
      estimatedCost: 30000,
      estimatedProfit: 18000,
      margin: 37.5,
      currency: DEFAULT_CURRENCY,
    },
    logistics: {
      harvestStartTime: '06:00',
      expectedDuration: 8,
      requiredPersonnel: 12,
      transportType: 'truck',
      coldChainRequired: true,
    },
    customerOrder: {
      customerName: 'Fresh Fish Market Co.',
      orderId: 'ORD-2024-0456',
      orderQuantity: 4000,
      orderUnit: 'kg',
    },
    createdBy: 'user-1',
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-10T14:30:00Z',
    daysUntilHarvest: 12,
    isWithinWindow: true,
    canEdit: true,
    canStartHarvest: true,
    isOverdue: false,
  },
  {
    id: 'hp-2',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00002',
    name: 'Partial Harvest - Sea Bream',
    description: 'Selective harvest of larger fish from Sea Bream batch',
    batchId: 'batch-2',
    batchNumber: 'B-2024-002',
    status: 'approved',
    harvestType: 'partial',
    plannedDate: '2024-03-20',
    criteria: {
      targetWeight: { min: 400, max: 500, target: 450 },
      targetQuantity: { value: 30, unit: 'percent' },
    },
    harvestMethod: 'net',
    productForm: 'fresh_gutted',
    estimates: {
      estimatedQuantity: 3000,
      estimatedBiomass: 1350,
      estimatedAvgWeight: 450,
      estimatedYield: 82,
      confidenceLevel: 'medium',
    },
    financialProjection: {
      estimatedRevenue: 20250,
      estimatedPrice: 15,
      priceUnit: 'per_kg',
      estimatedCost: 12000,
      estimatedProfit: 8250,
      margin: 40.7,
      currency: DEFAULT_CURRENCY,
    },
    createdBy: 'user-1',
    createdAt: '2024-02-05T09:00:00Z',
    updatedAt: '2024-02-08T11:00:00Z',
    daysUntilHarvest: 17,
    canEdit: true,
    canSchedule: true,
    isOverdue: false,
  },
  {
    id: 'hp-3',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00003',
    name: 'Emergency Thinning - Trout',
    description: 'Emergency thinning due to high density',
    batchId: 'batch-3',
    batchNumber: 'B-2024-003',
    status: 'in_progress',
    harvestType: 'thinning',
    plannedDate: '2024-03-03',
    confirmedDate: '2024-03-03',
    criteria: {
      targetWeight: { min: 250, max: 350, target: 300 },
      targetQuantity: { value: 2000, unit: 'pieces' },
    },
    harvestMethod: 'pump',
    productForm: 'live',
    estimates: {
      estimatedQuantity: 2000,
      estimatedBiomass: 600,
      estimatedAvgWeight: 300,
      estimatedYield: 100,
      confidenceLevel: 'high',
    },
    createdBy: 'user-2',
    createdAt: '2024-03-01T08:00:00Z',
    updatedAt: '2024-03-03T06:00:00Z',
    daysUntilHarvest: 0,
    canEdit: true,
    canComplete: true,
    isOverdue: false,
  },
  {
    id: 'hp-4',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00004',
    name: 'Draft Plan - New Batch',
    batchId: 'batch-1',
    batchNumber: 'B-2024-001',
    status: 'draft',
    harvestType: 'full',
    plannedDate: '2024-04-01',
    criteria: {
      targetWeight: { min: 400, max: 500, target: 450 },
    },
    productForm: 'fresh_whole',
    estimates: {
      estimatedQuantity: 8000,
      estimatedBiomass: 3600,
      estimatedAvgWeight: 450,
      estimatedYield: 85,
      confidenceLevel: 'low',
    },
    createdBy: 'user-1',
    createdAt: '2024-02-28T10:00:00Z',
    updatedAt: '2024-02-28T10:00:00Z',
    daysUntilHarvest: 29,
    canEdit: true,
    canDelete: true,
    isOverdue: false,
  },
  {
    id: 'hp-5',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00005',
    name: 'Completed Harvest - January',
    batchId: 'batch-2',
    batchNumber: 'B-2024-002',
    status: 'completed',
    harvestType: 'full',
    plannedDate: '2024-01-15',
    confirmedDate: '2024-01-15',
    criteria: {
      targetWeight: { min: 350, max: 450, target: 400 },
    },
    productForm: 'fresh_whole',
    estimates: {
      estimatedQuantity: 5000,
      estimatedBiomass: 2000,
      estimatedAvgWeight: 400,
      estimatedYield: 85,
      confidenceLevel: 'high',
    },
    actualQuantityHarvested: 4850,
    actualBiomassHarvested: 1940,
    actualAvgWeight: 400,
    createdBy: 'user-1',
    createdAt: '2024-01-01T10:00:00Z',
    updatedAt: '2024-01-15T18:00:00Z',
    canEdit: false,
    isOverdue: false,
  },
  {
    id: 'hp-6',
    tenantId: 'tenant-1',
    planCode: 'HP-2024-00006',
    name: 'Overdue Plan',
    batchId: 'batch-3',
    batchNumber: 'B-2024-003',
    status: 'planned',
    harvestType: 'partial',
    plannedDate: '2024-02-25',
    criteria: {
      targetWeight: { min: 300, max: 400, target: 350 },
    },
    productForm: 'fresh_whole',
    estimates: {
      estimatedQuantity: 1500,
      estimatedBiomass: 525,
      estimatedAvgWeight: 350,
      estimatedYield: 85,
      confidenceLevel: 'medium',
    },
    createdBy: 'user-2',
    createdAt: '2024-02-15T10:00:00Z',
    updatedAt: '2024-02-15T10:00:00Z',
    daysUntilHarvest: -6,
    canEdit: true,
    canApprove: true,
    isOverdue: true,
  },
];

const _mockStats: HarvestPlanStats = {
  total: 6,
  draft: 1,
  planned: 1,
  approved: 1,
  scheduled: 1,
  inProgress: 1,
  completed: 1,
  cancelled: 0,
  postponed: 0,
  totalEstimatedBiomass: 12075,
  totalActualBiomass: 1940,
  upcomingCount: 3,
  overdueCount: 1,
};

// ============================================================================
// CONSTANTS
// ============================================================================

const STATUS_CONFIG: Record<
  HarvestPlanStatus,
  { label: string; color: string; bgColor: string; icon: React.ReactNode }
> = {
  draft: {
    label: 'Draft',
    color: 'text-gray-700',
    bgColor: 'bg-gray-100',
    icon: <FileText className="w-4 h-4" />,
  },
  planned: {
    label: 'Planned',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
    icon: <Calendar className="w-4 h-4" />,
  },
  approved: {
    label: 'Approved',
    color: 'text-indigo-700',
    bgColor: 'bg-indigo-100',
    icon: <CheckCircle className="w-4 h-4" />,
  },
  scheduled: {
    label: 'Scheduled',
    color: 'text-purple-700',
    bgColor: 'bg-purple-100',
    icon: <Clock className="w-4 h-4" />,
  },
  in_progress: {
    label: 'In Progress',
    color: 'text-yellow-700',
    bgColor: 'bg-yellow-100',
    icon: <Play className="w-4 h-4" />,
  },
  completed: {
    label: 'Completed',
    color: 'text-green-700',
    bgColor: 'bg-green-100',
    icon: <Check className="w-4 h-4" />,
  },
  cancelled: {
    label: 'Cancelled',
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    icon: <XCircle className="w-4 h-4" />,
  },
  postponed: {
    label: 'Postponed',
    color: 'text-orange-700',
    bgColor: 'bg-orange-100',
    icon: <Pause className="w-4 h-4" />,
  },
};

const HARVEST_TYPE_CONFIG: Record<HarvestType, { label: string; color: string }> = {
  full: { label: 'Full Harvest', color: 'text-blue-600' },
  partial: { label: 'Partial Harvest', color: 'text-purple-600' },
  selective: { label: 'Selective', color: 'text-indigo-600' },
  emergency: { label: 'Emergency', color: 'text-red-600' },
  thinning: { label: 'Thinning', color: 'text-orange-600' },
};

const PRODUCT_FORM_LABELS: Record<ProductForm, string> = {
  live: 'Live',
  fresh_whole: 'Fresh Whole',
  fresh_gutted: 'Fresh Gutted',
  frozen_whole: 'Frozen Whole',
  frozen_gutted: 'Frozen Gutted',
  fillet: 'Fillet',
  processed: 'Processed',
};

const HARVEST_METHOD_LABELS: Record<HarvestMethod, string> = {
  net: 'Net/Scoop',
  pump: 'Pump',
  drain: 'Drain',
  manual: 'Manual',
  crowder: 'Crowder System',
};

const KANBAN_COLUMNS: HarvestPlanStatus[] = [
  'draft',
  'planned',
  'approved',
  'scheduled',
  'in_progress',
  'completed',
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const formatNumber = (num: number): string => {
  return num.toLocaleString();
};

const formatCurrency = (amount: number, currency: string = DEFAULT_CURRENCY): string => {
  return sharedFormatCurrency(amount, currency);
};

// ============================================================================
// COMPONENTS
// ============================================================================

// Status Badge Component
const StatusBadge: React.FC<{ status: HarvestPlanStatus; showIcon?: boolean }> = ({
  status,
  showIcon = true,
}) => {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bgColor} ${config.color}`}
    >
      {showIcon && config.icon}
      {config.label}
    </span>
  );
};

// Stats Card Component
const StatsCard: React.FC<{
  title: string;
  value: number | string;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
  onClick?: () => void;
}> = ({ title, value, subtitle, icon, color, onClick }) => (
  <div
    className={`bg-white rounded-lg shadow p-4 ${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
    onClick={onClick}
  >
    <div className="flex items-center">
      <div className={`flex-shrink-0 p-3 rounded-lg ${color}`}>{icon}</div>
      <div className="ml-4">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
        {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
      </div>
    </div>
  </div>
);

// Plan Card Component for Cards/Kanban View
const PlanCard: React.FC<{
  plan: HarvestPlan;
  onEdit: (plan: HarvestPlan) => void;
  onDelete: (plan: HarvestPlan) => void;
  onWorkflowAction: (plan: HarvestPlan, action: string) => void;
  compact?: boolean;
}> = ({ plan, onEdit, onDelete, onWorkflowAction, compact = false }) => {
  const [showActions, setShowActions] = useState(false);

  const getWorkflowActions = () => {
    const actions: { label: string; action: string; icon: React.ReactNode; color: string }[] = [];

    if (plan.status === 'draft') {
      actions.push({
        label: 'Submit for Approval',
        action: 'submit',
        icon: <ArrowRight className="w-4 h-4" />,
        color: 'text-blue-600',
      });
    }
    if (plan.canApprove) {
      actions.push({
        label: 'Approve',
        action: 'approve',
        icon: <CheckCircle className="w-4 h-4" />,
        color: 'text-green-600',
      });
    }
    if (plan.canSchedule) {
      actions.push({
        label: 'Schedule',
        action: 'schedule',
        icon: <Calendar className="w-4 h-4" />,
        color: 'text-purple-600',
      });
    }
    if (plan.canStartHarvest) {
      actions.push({
        label: 'Start Harvest',
        action: 'start',
        icon: <Play className="w-4 h-4" />,
        color: 'text-yellow-600',
      });
    }
    if (plan.canComplete) {
      actions.push({
        label: 'Complete Harvest',
        action: 'complete',
        icon: <Check className="w-4 h-4" />,
        color: 'text-green-600',
      });
    }
    if (plan.canEdit && plan.status !== 'completed' && plan.status !== 'cancelled') {
      actions.push({
        label: 'Postpone',
        action: 'postpone',
        icon: <Pause className="w-4 h-4" />,
        color: 'text-orange-600',
      });
      actions.push({
        label: 'Cancel',
        action: 'cancel',
        icon: <XCircle className="w-4 h-4" />,
        color: 'text-red-600',
      });
    }

    return actions;
  };

  const workflowActions = getWorkflowActions();

  if (compact) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-3 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="text-sm font-medium text-gray-900 truncate">{plan.planCode}</p>
            <p className="text-xs text-gray-500 truncate">{plan.name}</p>
          </div>
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-1 rounded hover:bg-gray-100"
            >
              <MoreVertical className="w-4 h-4 text-gray-400" />
            </button>
            {showActions && (
              <div className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg z-10 border border-gray-200">
                {plan.canEdit && (
                  <button
                    onClick={() => {
                      onEdit(plan);
                      setShowActions(false);
                    }}
                    className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit className="w-4 h-4 mr-2" />
                    Edit
                  </button>
                )}
                {workflowActions.map((wa) => (
                  <button
                    key={wa.action}
                    onClick={() => {
                      onWorkflowAction(plan, wa.action);
                      setShowActions(false);
                    }}
                    className={`flex items-center w-full px-4 py-2 text-sm hover:bg-gray-50 ${wa.color}`}
                  >
                    {wa.icon}
                    <span className="ml-2">{wa.label}</span>
                  </button>
                ))}
                {plan.canDelete && (
                  <button
                    onClick={() => {
                      onDelete(plan);
                      setShowActions(false);
                    }}
                    className="flex items-center w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Calendar className="w-3 h-3" />
          {formatDate(plan.plannedDate)}
          {plan.isOverdue && (
            <span className="text-red-600 font-medium flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Overdue
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-gray-500">{plan.batchNumber}</span>
          <span className="text-xs font-medium text-gray-700">
            {formatNumber(plan.estimates.estimatedBiomass)} kg
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow hover:shadow-md transition-shadow">
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">{plan.planCode}</h3>
              <StatusBadge status={plan.status} />
              {plan.isOverdue && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                  <AlertTriangle className="w-3 h-3" />
                  Overdue
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600 mt-1">{plan.name}</p>
          </div>
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-1.5 rounded-md hover:bg-gray-100"
            >
              <MoreVertical className="w-5 h-5 text-gray-400" />
            </button>
            {showActions && (
              <div className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg z-10 border border-gray-200">
                {plan.canEdit && (
                  <button
                    onClick={() => {
                      onEdit(plan);
                      setShowActions(false);
                    }}
                    className="flex items-center w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit className="w-4 h-4 mr-2" />
                    Edit
                  </button>
                )}
                {workflowActions.map((wa) => (
                  <button
                    key={wa.action}
                    onClick={() => {
                      onWorkflowAction(plan, wa.action);
                      setShowActions(false);
                    }}
                    className={`flex items-center w-full px-4 py-2 text-sm hover:bg-gray-50 ${wa.color}`}
                  >
                    {wa.icon}
                    <span className="ml-2">{wa.label}</span>
                  </button>
                ))}
                {plan.canDelete && (
                  <button
                    onClick={() => {
                      onDelete(plan);
                      setShowActions(false);
                    }}
                    className="flex items-center w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Batch Info */}
        <div className="flex items-center gap-2 text-sm">
          <Package className="w-4 h-4 text-gray-400" />
          <span className="text-gray-600">Batch:</span>
          <span className="font-medium text-gray-900">{plan.batchNumber}</span>
        </div>

        {/* Dates */}
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="w-4 h-4 text-gray-400" />
          <span className="text-gray-600">Planned:</span>
          <span className="font-medium text-gray-900">{formatDate(plan.plannedDate)}</span>
          {plan.daysUntilHarvest !== undefined && plan.daysUntilHarvest >= 0 && (
            <span className="text-xs text-gray-500">({plan.daysUntilHarvest} days)</span>
          )}
        </div>

        {/* Harvest Type & Method */}
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-gray-400" />
            <span className={HARVEST_TYPE_CONFIG[plan.harvestType].color}>
              {HARVEST_TYPE_CONFIG[plan.harvestType].label}
            </span>
          </div>
          {plan.harvestMethod && (
            <span className="text-gray-500">{HARVEST_METHOD_LABELS[plan.harvestMethod]}</span>
          )}
        </div>

        {/* Estimates */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t border-gray-100">
          <div className="text-center">
            <p className="text-xs text-gray-500">Quantity</p>
            <p className="text-sm font-semibold text-gray-900">
              {formatNumber(plan.estimates.estimatedQuantity)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">Biomass</p>
            <p className="text-sm font-semibold text-gray-900">
              {formatNumber(plan.estimates.estimatedBiomass)} kg
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500">Avg Weight</p>
            <p className="text-sm font-semibold text-gray-900">
              {plan.estimates.estimatedAvgWeight}g
            </p>
          </div>
        </div>

        {/* Financial Info */}
        {plan.financialProjection && (
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <div className="flex items-center gap-2 text-sm">
              <DollarSign className="w-4 h-4 text-green-500" />
              <span className="text-gray-600">Est. Revenue:</span>
              <span className="font-semibold text-green-600">
                {formatCurrency(
                  plan.financialProjection.estimatedRevenue,
                  plan.financialProjection.currency,
                )}
              </span>
            </div>
            <span className="text-xs text-gray-500">
              Margin: {plan.financialProjection.margin.toFixed(1)}%
            </span>
          </div>
        )}

        {/* Customer Info */}
        {plan.customerOrder?.customerName && (
          <div className="flex items-center gap-2 text-sm pt-2 border-t border-gray-100">
            <Users className="w-4 h-4 text-gray-400" />
            <span className="text-gray-600">Customer:</span>
            <span className="font-medium text-gray-900">{plan.customerOrder.customerName}</span>
          </div>
        )}

        {/* Actual Results for Completed */}
        {plan.status === 'completed' && plan.actualBiomassHarvested && (
          <div className="bg-green-50 rounded-md p-3 mt-2">
            <p className="text-xs font-medium text-green-800 mb-2">Actual Results</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-xs text-green-600">Quantity</p>
                <p className="text-sm font-semibold text-green-800">
                  {formatNumber(plan.actualQuantityHarvested || 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-green-600">Biomass</p>
                <p className="text-sm font-semibold text-green-800">
                  {formatNumber(plan.actualBiomassHarvested)} kg
                </p>
              </div>
              <div>
                <p className="text-xs text-green-600">Avg Weight</p>
                <p className="text-sm font-semibold text-green-800">{plan.actualAvgWeight}g</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Filter Panel Component
const FilterPanel: React.FC<{
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  onReset: () => void;
  batches: { id: string; batchNumber: string; name: string }[];
}> = ({ filters, onFilterChange, onReset, batches }) => {
  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900 flex items-center gap-2">
          <Filter className="w-4 h-4" />
          Filters
        </h3>
        <button
          onClick={onReset}
          className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" />
          Reset
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Search */}
        <div className="lg:col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">Search</label>
          <div className="relative">
            <input
              type="text"
              value={filters.searchText}
              onChange={(e) => onFilterChange({ ...filters, searchText: e.target.value })}
              placeholder="Search by plan code, name..."
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm pl-9"
            />
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          </div>
        </div>

        {/* Status Filter */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
          <select
            value={filters.status}
            onChange={(e) =>
              onFilterChange({ ...filters, status: e.target.value as HarvestPlanStatus | '' })
            }
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          >
            <option value="">All Statuses</option>
            {Object.entries(STATUS_CONFIG).map(([value, config]) => (
              <option key={value} value={value}>
                {config.label}
              </option>
            ))}
          </select>
        </div>

        {/* Harvest Type Filter */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Harvest Type</label>
          <select
            value={filters.harvestType}
            onChange={(e) =>
              onFilterChange({ ...filters, harvestType: e.target.value as HarvestType | '' })
            }
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          >
            <option value="">All Types</option>
            {Object.entries(HARVEST_TYPE_CONFIG).map(([value, config]) => (
              <option key={value} value={value}>
                {config.label}
              </option>
            ))}
          </select>
        </div>

        {/* Batch Filter */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Batch</label>
          <select
            value={filters.batchId}
            onChange={(e) => onFilterChange({ ...filters, batchId: e.target.value })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          >
            <option value="">All Batches</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.batchNumber} - {batch.name}
              </option>
            ))}
          </select>
        </div>

        {/* Date From */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Planned From</label>
          <input
            type="date"
            value={filters.plannedDateFrom}
            onChange={(e) => onFilterChange({ ...filters, plannedDateFrom: e.target.value })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
        </div>

        {/* Date To */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Planned To</label>
          <input
            type="date"
            value={filters.plannedDateTo}
            onChange={(e) => onFilterChange({ ...filters, plannedDateTo: e.target.value })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
        </div>

        {/* Quick Filters */}
        <div className="lg:col-span-2 flex items-end gap-4">
          <label className="inline-flex items-center">
            <input
              type="checkbox"
              checked={filters.activeOnly}
              onChange={(e) => onFilterChange({ ...filters, activeOnly: e.target.checked })}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="ml-2 text-sm text-gray-700">Active Only</span>
          </label>
          <label className="inline-flex items-center">
            <input
              type="checkbox"
              checked={filters.overdueOnly}
              onChange={(e) => onFilterChange({ ...filters, overdueOnly: e.target.checked })}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="ml-2 text-sm text-gray-700">Overdue Only</span>
          </label>
        </div>
      </div>
    </div>
  );
};

// Create/Edit Form Modal
const HarvestPlanFormModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (plan: Partial<HarvestPlan>) => void;
  plan?: HarvestPlan | null;
  batches: { id: string; batchNumber: string; name: string }[];
}> = ({ isOpen, onClose, onSave, plan, batches }) => {
  const [formData, setFormData] = useState<Partial<HarvestPlan>>(
    plan || {
      name: '',
      batchId: '',
      harvestType: 'full',
      plannedDate: '',
      productForm: 'fresh_whole',
      criteria: {
        targetWeight: { min: 0, max: 0, target: 0 },
      },
      estimates: {
        estimatedQuantity: 0,
        estimatedBiomass: 0,
        estimatedAvgWeight: 0,
        estimatedYield: 85,
        confidenceLevel: 'medium',
      },
    },
  );

  const [activeSection, setActiveSection] = useState<string>('basic');

  const sections = [
    { id: 'basic', label: 'Basic Info', icon: <FileText className="w-4 h-4" /> },
    { id: 'criteria', label: 'Criteria', icon: <Target className="w-4 h-4" /> },
    { id: 'estimates', label: 'Estimates', icon: <Scale className="w-4 h-4" /> },
    { id: 'financial', label: 'Financial', icon: <DollarSign className="w-4 h-4" /> },
    { id: 'logistics', label: 'Logistics', icon: <Truck className="w-4 h-4" /> },
    { id: 'customer', label: 'Customer', icon: <Users className="w-4 h-4" /> },
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={plan ? 'Edit Harvest Plan' : 'Create Harvest Plan'}
      size="xl"
    >
      <form onSubmit={handleSubmit}>
        <div className="flex">
          {/* Sidebar */}
          <div className="w-48 border-r border-gray-200 bg-gray-50 p-4">
            <nav className="space-y-1">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md transition-colors ${
                    activeSection === section.id
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {section.icon}
                  {section.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Form Content */}
          <div className="flex-1 p-6 overflow-y-auto max-h-[60vh]">
            {/* Basic Info Section */}
            {activeSection === 'basic' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Basic Information</h3>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Plan Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name || ''}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    placeholder="e.g., Full Harvest - Sea Bass Batch A"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    value={formData.description || ''}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={3}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    placeholder="Describe the harvest plan..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Batch *</label>
                  <select
                    required
                    value={formData.batchId || ''}
                    onChange={(e) => setFormData({ ...formData, batchId: e.target.value })}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  >
                    <option value="">Select a batch</option>
                    {batches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.batchNumber} - {batch.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Harvest Type *
                    </label>
                    <select
                      required
                      value={formData.harvestType || 'full'}
                      onChange={(e) =>
                        setFormData({ ...formData, harvestType: e.target.value as HarvestType })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      {Object.entries(HARVEST_TYPE_CONFIG).map(([value, config]) => (
                        <option key={value} value={value}>
                          {config.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Harvest Method
                    </label>
                    <select
                      value={formData.harvestMethod || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          harvestMethod: (e.target.value as HarvestMethod) || undefined,
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="">Select method</option>
                      {Object.entries(HARVEST_METHOD_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Product Form *
                    </label>
                    <select
                      required
                      value={formData.productForm || 'fresh_whole'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          productForm: e.target.value as ProductForm,
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      {Object.entries(PRODUCT_FORM_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Planned Date *
                    </label>
                    <input
                      type="date"
                      required
                      value={formData.plannedDate || ''}
                      onChange={(e) => setFormData({ ...formData, plannedDate: e.target.value })}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Window Start
                    </label>
                    <input
                      type="date"
                      value={formData.windowStartDate || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, windowStartDate: e.target.value })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Window End
                    </label>
                    <input
                      type="date"
                      value={formData.windowEndDate || ''}
                      onChange={(e) => setFormData({ ...formData, windowEndDate: e.target.value })}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Criteria Section */}
            {activeSection === 'criteria' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Harvest Criteria</h3>

                <div className="bg-gray-50 rounded-md p-4">
                  <h4 className="text-xs font-medium text-gray-700 mb-3">Target Weight (grams)</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Minimum</label>
                      <input
                        type="number"
                        min="0"
                        value={formData.criteria?.targetWeight.min || 0}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            criteria: {
                              ...formData.criteria!,
                              targetWeight: {
                                ...formData.criteria!.targetWeight,
                                min: Number(e.target.value),
                              },
                            },
                          })
                        }
                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Target</label>
                      <input
                        type="number"
                        min="0"
                        value={formData.criteria?.targetWeight.target || 0}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            criteria: {
                              ...formData.criteria!,
                              targetWeight: {
                                ...formData.criteria!.targetWeight,
                                target: Number(e.target.value),
                              },
                            },
                          })
                        }
                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Maximum</label>
                      <input
                        type="number"
                        min="0"
                        value={formData.criteria?.targetWeight.max || 0}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            criteria: {
                              ...formData.criteria!,
                              targetWeight: {
                                ...formData.criteria!.targetWeight,
                                max: Number(e.target.value),
                              },
                            },
                          })
                        }
                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Quality Grade
                  </label>
                  <select
                    value={formData.criteria?.qualityGrade || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        criteria: {
                          ...formData.criteria!,
                          qualityGrade: e.target.value || undefined,
                        },
                      })
                    }
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  >
                    <option value="">Not specified</option>
                    <option value="A">Grade A</option>
                    <option value="B">Grade B</option>
                    <option value="C">Grade C</option>
                  </select>
                </div>
              </div>
            )}

            {/* Estimates Section */}
            {activeSection === 'estimates' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Harvest Estimates</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Quantity *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      value={formData.estimates?.estimatedQuantity || 0}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          estimates: {
                            ...formData.estimates!,
                            estimatedQuantity: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Biomass (kg) *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      step="0.1"
                      value={formData.estimates?.estimatedBiomass || 0}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          estimates: {
                            ...formData.estimates!,
                            estimatedBiomass: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Avg Weight (g) *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      value={formData.estimates?.estimatedAvgWeight || 0}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          estimates: {
                            ...formData.estimates!,
                            estimatedAvgWeight: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Yield (%)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={formData.estimates?.estimatedYield || 85}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          estimates: {
                            ...formData.estimates!,
                            estimatedYield: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Confidence Level
                  </label>
                  <select
                    value={formData.estimates?.confidenceLevel || 'medium'}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        estimates: {
                          ...formData.estimates!,
                          confidenceLevel: e.target.value as 'low' | 'medium' | 'high',
                        },
                      })
                    }
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
            )}

            {/* Financial Section */}
            {activeSection === 'financial' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Financial Projection</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Price
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.financialProjection?.estimatedPrice || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          financialProjection: {
                            ...formData.financialProjection,
                            estimatedPrice: Number(e.target.value),
                            priceUnit: formData.financialProjection?.priceUnit || 'per_kg',
                            estimatedRevenue: formData.financialProjection?.estimatedRevenue || 0,
                            estimatedCost: formData.financialProjection?.estimatedCost || 0,
                            estimatedProfit: formData.financialProjection?.estimatedProfit || 0,
                            margin: formData.financialProjection?.margin || 0,
                            currency: formData.financialProjection?.currency || 'EUR',
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Price Unit
                    </label>
                    <select
                      value={formData.financialProjection?.priceUnit || 'per_kg'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          financialProjection: {
                            ...formData.financialProjection!,
                            priceUnit: e.target.value as 'per_kg' | 'per_piece',
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="per_kg">Per Kilogram</option>
                      <option value="per_piece">Per Piece</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Revenue
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.financialProjection?.estimatedRevenue || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          financialProjection: {
                            ...formData.financialProjection!,
                            estimatedRevenue: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Estimated Cost
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.financialProjection?.estimatedCost || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          financialProjection: {
                            ...formData.financialProjection!,
                            estimatedCost: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                    <select
                      value={formData.financialProjection?.currency || 'EUR'}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          financialProjection: {
                            ...formData.financialProjection!,
                            currency: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                      <option value="TRY">TRY</option>
                      <option value="GBP">GBP</option>
                      <option value="NOK">NOK</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Logistics Section */}
            {activeSection === 'logistics' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Logistics Plan</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Harvest Start Time
                    </label>
                    <input
                      type="time"
                      value={formData.logistics?.harvestStartTime || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          logistics: {
                            ...formData.logistics,
                            harvestStartTime: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Expected Duration (hours)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={formData.logistics?.expectedDuration || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          logistics: {
                            ...formData.logistics,
                            expectedDuration: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Required Personnel
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formData.logistics?.requiredPersonnel || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          logistics: {
                            ...formData.logistics,
                            requiredPersonnel: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Transport Type
                    </label>
                    <select
                      value={formData.logistics?.transportType || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          logistics: {
                            ...formData.logistics,
                            transportType:
                              (e.target.value as 'truck' | 'boat' | 'container') || undefined,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="">Select type</option>
                      <option value="truck">Truck</option>
                      <option value="boat">Boat</option>
                      <option value="container">Container</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Destination Type
                    </label>
                    <select
                      value={formData.logistics?.destinationType || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          logistics: {
                            ...formData.logistics,
                            destinationType:
                              (e.target.value as
                                | 'processing'
                                | 'market'
                                | 'direct_sale'
                                | 'export') || undefined,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="">Select destination</option>
                      <option value="processing">Processing Plant</option>
                      <option value="market">Market</option>
                      <option value="direct_sale">Direct Sale</option>
                      <option value="export">Export</option>
                    </select>
                  </div>

                  <div>
                    <label className="inline-flex items-center mt-6">
                      <input
                        type="checkbox"
                        checked={formData.logistics?.coldChainRequired || false}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            logistics: {
                              ...formData.logistics,
                              coldChainRequired: e.target.checked,
                            },
                          })
                        }
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="ml-2 text-sm text-gray-700">Cold Chain Required</span>
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Destination Address
                  </label>
                  <textarea
                    value={formData.logistics?.destinationAddress || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        logistics: {
                          ...formData.logistics,
                          destinationAddress: e.target.value,
                        },
                      })
                    }
                    rows={2}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  />
                </div>
              </div>
            )}

            {/* Customer Section */}
            {activeSection === 'customer' && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-gray-900 mb-4">
                  Customer / Order Information
                </h3>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Customer Name
                    </label>
                    <input
                      type="text"
                      value={formData.customerOrder?.customerName || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            customerName: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Order ID</label>
                    <input
                      type="text"
                      value={formData.customerOrder?.orderId || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            orderId: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Order Quantity
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formData.customerOrder?.orderQuantity || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            orderQuantity: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Order Unit
                    </label>
                    <select
                      value={formData.customerOrder?.orderUnit || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            orderUnit: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    >
                      <option value="">Select unit</option>
                      <option value="kg">Kilograms</option>
                      <option value="pieces">Pieces</option>
                      <option value="tons">Tons</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Delivery Date
                    </label>
                    <input
                      type="date"
                      value={formData.customerOrder?.deliveryDate || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            deliveryDate: e.target.value,
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Contract Price
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.customerOrder?.contractPrice || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          customerOrder: {
                            ...formData.customerOrder,
                            contractPrice: Number(e.target.value),
                          },
                        })
                      }
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700"
          >
            {plan ? 'Update Plan' : 'Create Plan'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Complete Harvest Modal
const CompleteHarvestModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onComplete: (data: {
    actualQuantity: number;
    actualBiomass: number;
    actualAvgWeight: number;
  }) => void;
  plan: HarvestPlan | null;
}> = ({ isOpen, onClose, onComplete, plan }) => {
  const [formData, setFormData] = useState({
    actualQuantity: plan?.estimates.estimatedQuantity || 0,
    actualBiomass: plan?.estimates.estimatedBiomass || 0,
    actualAvgWeight: plan?.estimates.estimatedAvgWeight || 0,
  });

  if (!plan) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onComplete(formData);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Complete Harvest" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-blue-50 rounded-md p-3 mb-4">
          <p className="text-sm text-blue-800">
            Enter the actual harvest results for <strong>{plan.planCode}</strong>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Actual Quantity Harvested
          </label>
          <input
            type="number"
            required
            min="0"
            value={formData.actualQuantity}
            onChange={(e) => setFormData({ ...formData, actualQuantity: Number(e.target.value) })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Estimated: {formatNumber(plan.estimates.estimatedQuantity)}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Actual Biomass (kg)
          </label>
          <input
            type="number"
            required
            min="0"
            step="0.1"
            value={formData.actualBiomass}
            onChange={(e) => setFormData({ ...formData, actualBiomass: Number(e.target.value) })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Estimated: {formatNumber(plan.estimates.estimatedBiomass)} kg
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Actual Average Weight (g)
          </label>
          <input
            type="number"
            required
            min="0"
            step="0.1"
            value={formData.actualAvgWeight}
            onChange={(e) => setFormData({ ...formData, actualAvgWeight: Number(e.target.value) })}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Estimated: {plan.estimates.estimatedAvgWeight}g
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 border border-transparent rounded-md hover:bg-green-700"
          >
            Complete Harvest
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Schedule Modal
const ScheduleModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSchedule: (confirmedDate: string) => void;
  plan: HarvestPlan | null;
}> = ({ isOpen, onClose, onSchedule, plan }) => {
  const [confirmedDate, setConfirmedDate] = useState(plan?.plannedDate || '');

  if (!plan) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSchedule(confirmedDate);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Schedule Harvest" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-purple-50 rounded-md p-3 mb-4">
          <p className="text-sm text-purple-800">
            Set the confirmed harvest date for <strong>{plan.planCode}</strong>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Confirmed Harvest Date *
          </label>
          <input
            type="date"
            required
            value={confirmedDate}
            onChange={(e) => setConfirmedDate(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Originally planned: {formatDate(plan.plannedDate)}
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-purple-600 border border-transparent rounded-md hover:bg-purple-700"
          >
            Schedule Harvest
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Postpone Modal
const PostponeModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onPostpone: (newDate: string) => void;
  plan: HarvestPlan | null;
}> = ({ isOpen, onClose, onPostpone, plan }) => {
  const [newDate, setNewDate] = useState('');

  if (!plan) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onPostpone(newDate);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Postpone Harvest" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-orange-50 rounded-md p-3 mb-4">
          <p className="text-sm text-orange-800">
            Postpone <strong>{plan.planCode}</strong> to a new date
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">New Planned Date *</label>
          <input
            type="date"
            required
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">Current date: {formatDate(plan.plannedDate)}</p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-orange-600 border border-transparent rounded-md hover:bg-orange-700"
          >
            Postpone
          </button>
        </div>
      </form>
    </Modal>
  );
};

// Confirm Delete Modal
const ConfirmDeleteModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  plan: HarvestPlan | null;
}> = ({ isOpen, onClose, onConfirm, plan }) => {
  if (!plan) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false}>
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-shrink-0 p-3 bg-red-100 rounded-full">
          <Trash2 className="w-6 h-6 text-red-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Delete Harvest Plan</h2>
          <p className="text-sm text-gray-500">This action cannot be undone.</p>
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-6">
        Are you sure you want to delete <strong>{plan.planCode}</strong> - {plan.name}?
      </p>

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
        >
          Delete
        </button>
      </div>
    </Modal>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const HarvestPlansPage: React.FC = () => {
  // State
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [showFilters, setShowFilters] = useState(true);
  const [filters, setFilters] = useState<FilterState>({
    searchText: '',
    status: '',
    harvestType: '',
    batchId: '',
    plannedDateFrom: '',
    plannedDateTo: '',
    activeOnly: false,
    overdueOnly: false,
  });

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<HarvestPlan | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<HarvestPlan | null>(null);
  const [completingPlan, setCompletingPlan] = useState<HarvestPlan | null>(null);
  const [schedulingPlan, setSchedulingPlan] = useState<HarvestPlan | null>(null);
  const [postponingPlan, setPostponingPlan] = useState<HarvestPlan | null>(null);

  // Build API filter from local filter state
  const apiFilter = useMemo((): HarvestPlanFilterInput => {
    const f: HarvestPlanFilterInput = {};
    if (filters.searchText) f.searchText = filters.searchText;
    if (filters.status) f.status = filters.status;
    if (filters.harvestType) f.harvestType = filters.harvestType;
    if (filters.batchId) f.batchId = filters.batchId;
    if (filters.plannedDateFrom) f.plannedDateFrom = filters.plannedDateFrom;
    if (filters.plannedDateTo) f.plannedDateTo = filters.plannedDateTo;
    if (filters.activeOnly) f.activeOnly = true;
    if (filters.overdueOnly) f.overdueOnly = true;
    return f;
  }, [filters]);

  // Data from API
  const { data: plansData, isLoading: plansLoading } = useHarvestPlanList(apiFilter);
  const { data: statsData } = useHarvestPlanStats();
  const { data: batchesData } = useBatchList(undefined, { limit: 100 });

  const plans = plansData?.items ?? [];
  const stats: HarvestPlanStats = statsData ?? {
    total: 0,
    draft: 0,
    planned: 0,
    approved: 0,
    scheduled: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    postponed: 0,
    totalEstimatedBiomass: 0,
    totalActualBiomass: 0,
    upcomingCount: 0,
    overdueCount: 0,
  };
  const batches = (batchesData?.items ?? []).map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    name: b.name || b.batchNumber,
  }));

  // Mutations
  const createMutation = useCreateHarvestPlan();
  const updateMutation = useUpdateHarvestPlan();
  const deleteMutation = useDeleteHarvestPlan();
  const approveMutation = useApproveHarvestPlan();
  const scheduleMutation = useScheduleHarvestPlan();
  const startMutation = useStartHarvestPlan();
  const completeMutation = useCompleteHarvestPlan();
  const cancelMutation = useCancelHarvestPlan();
  const postponeMutation = usePostponeHarvestPlan();

  // Plans are already filtered server-side via apiFilter
  const filteredPlans = plans;

  // Reset filters
  const resetFilters = useCallback(() => {
    setFilters({
      searchText: '',
      status: '',
      harvestType: '',
      batchId: '',
      plannedDateFrom: '',
      plannedDateTo: '',
      activeOnly: false,
      overdueOnly: false,
    });
  }, []);

  // Helper: convert form data to CreateHarvestPlanInput
  const toCreateInput = (planData: Partial<HarvestPlan>): CreateHarvestPlanInput => ({
    name: planData.name || '',
    description: planData.description,
    batchId: planData.batchId || '',
    harvestType: planData.harvestType,
    plannedDate: planData.plannedDate || '',
    windowStartDate: planData.windowStartDate || undefined,
    windowEndDate: planData.windowEndDate || undefined,
    criteria: {
      targetWeightMin: planData.criteria?.targetWeight?.min ?? 0,
      targetWeightMax: planData.criteria?.targetWeight?.max ?? 0,
      targetWeightTarget: planData.criteria?.targetWeight?.target ?? 0,
      targetQuantityValue: planData.criteria?.targetQuantity?.value,
      targetQuantityUnit: planData.criteria?.targetQuantity?.unit,
      qualityGrade: planData.criteria?.qualityGrade,
      minimumConditionFactor: planData.criteria?.minimumConditionFactor,
    },
    harvestMethod: planData.harvestMethod,
    productForm: planData.productForm,
    estimates: {
      estimatedQuantity: planData.estimates?.estimatedQuantity ?? 0,
      estimatedBiomass: planData.estimates?.estimatedBiomass ?? 0,
      estimatedAvgWeight: planData.estimates?.estimatedAvgWeight ?? 0,
      estimatedYield: planData.estimates?.estimatedYield ?? 85,
      confidenceLevel: planData.estimates?.confidenceLevel ?? 'medium',
    },
    financialProjection: planData.financialProjection
      ? {
          estimatedRevenue: planData.financialProjection.estimatedRevenue,
          estimatedPrice: planData.financialProjection.estimatedPrice,
          priceUnit: planData.financialProjection.priceUnit,
          estimatedCost: planData.financialProjection.estimatedCost,
          estimatedProfit: planData.financialProjection.estimatedProfit,
          margin: planData.financialProjection.margin,
          currency: planData.financialProjection.currency,
        }
      : undefined,
    logistics: planData.logistics ? { ...planData.logistics } : undefined,
    customerOrder: planData.customerOrder ? { ...planData.customerOrder } : undefined,
    qualityRequirements: planData.qualityRequirements
      ? { ...planData.qualityRequirements }
      : undefined,
    notes: planData.notes,
    attachments: planData.attachments,
  });

  // Handlers
  const handleCreatePlan = (planData: Partial<HarvestPlan>) => {
    const input = toCreateInput(planData);
    createMutation.mutate(input, {
      onSuccess: () => setShowCreateModal(false),
      onError: (err) => console.error('Failed to create harvest plan:', err),
    });
  };

  const handleUpdatePlan = (planData: Partial<HarvestPlan>) => {
    if (!editingPlan) return;
    const createInput = toCreateInput(planData);
    const input: UpdateHarvestPlanInput = {
      id: editingPlan.id,
      ...createInput,
    };
    updateMutation.mutate(input, {
      onSuccess: () => setEditingPlan(null),
      onError: (err) => console.error('Failed to update harvest plan:', err),
    });
  };

  const handleDeletePlan = () => {
    if (!deletingPlan) return;
    deleteMutation.mutate(deletingPlan.id, {
      onSuccess: () => setDeletingPlan(null),
      onError: (err) => console.error('Failed to delete harvest plan:', err),
    });
  };

  const handleWorkflowAction = (plan: HarvestPlan, action: string) => {
    switch (action) {
      case 'submit':
        // Submit for approval = update status to 'planned'
        updateMutation.mutate(
          { id: plan.id, status: 'planned' },
          { onError: (err) => console.error('Failed to submit plan:', err) },
        );
        break;
      case 'approve':
        approveMutation.mutate(plan.id, {
          onError: (err) => console.error('Failed to approve plan:', err),
        });
        break;
      case 'schedule':
        setSchedulingPlan(plan);
        break;
      case 'start':
        startMutation.mutate(plan.id, {
          onError: (err) => console.error('Failed to start harvest:', err),
        });
        break;
      case 'complete':
        setCompletingPlan(plan);
        break;
      case 'cancel':
        cancelMutation.mutate(plan.id, {
          onError: (err) => console.error('Failed to cancel plan:', err),
        });
        break;
      case 'postpone':
        setPostponingPlan(plan);
        break;
    }
  };

  const handleSchedule = (confirmedDate: string) => {
    if (!schedulingPlan) return;
    scheduleMutation.mutate(
      { id: schedulingPlan.id, confirmedDate },
      {
        onSuccess: () => setSchedulingPlan(null),
        onError: (err) => console.error('Failed to schedule plan:', err),
      },
    );
  };

  const handleComplete = (data: {
    actualQuantity: number;
    actualBiomass: number;
    actualAvgWeight: number;
  }) => {
    if (!completingPlan) return;
    completeMutation.mutate(
      {
        id: completingPlan.id,
        actualQuantity: data.actualQuantity,
        actualBiomass: data.actualBiomass,
        actualAvgWeight: data.actualAvgWeight,
      },
      {
        onSuccess: () => setCompletingPlan(null),
        onError: (err) => console.error('Failed to complete harvest:', err),
      },
    );
  };

  const handlePostpone = (newDate: string) => {
    if (!postponingPlan) return;
    postponeMutation.mutate(
      { id: postponingPlan.id, newDate },
      {
        onSuccess: () => setPostponingPlan(null),
        onError: (err) => console.error('Failed to postpone plan:', err),
      },
    );
  };

  // Group plans by status for Kanban view
  const plansByStatus = useMemo(() => {
    const grouped: Record<HarvestPlanStatus, HarvestPlan[]> = {
      draft: [],
      planned: [],
      approved: [],
      scheduled: [],
      in_progress: [],
      completed: [],
      cancelled: [],
      postponed: [],
    };

    filteredPlans.forEach((plan) => {
      grouped[plan.status].push(plan);
    });

    return grouped;
  }, [filteredPlans]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Harvest Plans</h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage harvest planning, scheduling, and execution
              </p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`inline-flex items-center px-3 py-2 border rounded-md text-sm font-medium transition-colors ${
                  showFilters
                    ? 'border-blue-500 text-blue-700 bg-blue-50'
                    : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                }`}
              >
                <Filter className="w-4 h-4 mr-2" />
                Filters
                {showFilters ? (
                  <ChevronDown className="w-4 h-4 ml-1" />
                ) : (
                  <ChevronRight className="w-4 h-4 ml-1" />
                )}
              </button>
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Plus className="w-4 h-4 mr-2" />
                New Plan
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-6 space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <StatsCard
            title="Draft"
            value={stats.draft}
            icon={<FileText className="w-5 h-5 text-gray-600" />}
            color="bg-gray-100"
            onClick={() => setFilters({ ...filters, status: 'draft' })}
          />
          <StatsCard
            title="Planned"
            value={stats.planned}
            icon={<Calendar className="w-5 h-5 text-blue-600" />}
            color="bg-blue-100"
            onClick={() => setFilters({ ...filters, status: 'planned' })}
          />
          <StatsCard
            title="Approved"
            value={stats.approved}
            icon={<CheckCircle className="w-5 h-5 text-indigo-600" />}
            color="bg-indigo-100"
            onClick={() => setFilters({ ...filters, status: 'approved' })}
          />
          <StatsCard
            title="Scheduled"
            value={stats.scheduled}
            icon={<Clock className="w-5 h-5 text-purple-600" />}
            color="bg-purple-100"
            onClick={() => setFilters({ ...filters, status: 'scheduled' })}
          />
          <StatsCard
            title="In Progress"
            value={stats.inProgress}
            icon={<Play className="w-5 h-5 text-yellow-600" />}
            color="bg-yellow-100"
            onClick={() => setFilters({ ...filters, status: 'in_progress' })}
          />
          <StatsCard
            title="Completed"
            value={stats.completed}
            icon={<Check className="w-5 h-5 text-green-600" />}
            color="bg-green-100"
            onClick={() => setFilters({ ...filters, status: 'completed' })}
          />
        </div>

        {/* Additional Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatsCard
            title="Est. Biomass"
            value={`${formatNumber(stats.totalEstimatedBiomass)} kg`}
            subtitle="Total planned"
            icon={<Scale className="w-5 h-5 text-blue-600" />}
            color="bg-blue-100"
          />
          <StatsCard
            title="Actual Harvested"
            value={`${formatNumber(stats.totalActualBiomass)} kg`}
            subtitle="Completed harvests"
            icon={<TrendingUp className="w-5 h-5 text-green-600" />}
            color="bg-green-100"
          />
          <StatsCard
            title="Upcoming"
            value={stats.upcomingCount}
            subtitle="Next 30 days"
            icon={<Calendar className="w-5 h-5 text-purple-600" />}
            color="bg-purple-100"
          />
          <StatsCard
            title="Overdue"
            value={stats.overdueCount}
            subtitle="Requires attention"
            icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
            color="bg-red-100"
            onClick={() => setFilters({ ...filters, overdueOnly: true })}
          />
        </div>

        {/* Filters */}
        {showFilters && (
          <FilterPanel
            filters={filters}
            onFilterChange={setFilters}
            onReset={resetFilters}
            batches={batches}
          />
        )}

        {/* View Mode Toggle */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {plansLoading
              ? 'Loading...'
              : `Showing ${filteredPlans.length} of ${plansData?.total ?? 0} plans`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode('cards')}
              className={`p-2 rounded-md ${
                viewMode === 'cards'
                  ? 'bg-blue-100 text-blue-600'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
              title="Card View"
            >
              <Grid className="w-5 h-5" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-2 rounded-md ${
                viewMode === 'table'
                  ? 'bg-blue-100 text-blue-600'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
              title="Table View"
            >
              <List className="w-5 h-5" />
            </button>
            <button
              onClick={() => setViewMode('kanban')}
              className={`p-2 rounded-md ${
                viewMode === 'kanban'
                  ? 'bg-blue-100 text-blue-600'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
              title="Kanban View"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content based on view mode */}
        {viewMode === 'cards' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredPlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onEdit={setEditingPlan}
                onDelete={setDeletingPlan}
                onWorkflowAction={handleWorkflowAction}
              />
            ))}
            {filteredPlans.length === 0 && (
              <div className="col-span-full text-center py-12 bg-white rounded-lg shadow">
                <FileText className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No harvest plans found</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Get started by creating a new harvest plan.
                </p>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="mt-4 inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  New Plan
                </button>
              </div>
            )}
          </div>
        )}

        {viewMode === 'table' && (
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Plan
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Batch
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Status
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Type
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Planned Date
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Est. Biomass
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    Est. Revenue
                  </th>
                  <th scope="col" className="relative px-6 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredPlans.map((plan) => (
                  <tr key={plan.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div>
                          <div className="text-sm font-medium text-gray-900">{plan.planCode}</div>
                          <div className="text-sm text-gray-500">{plan.name}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-900">{plan.batchNumber}</span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <StatusBadge status={plan.status} />
                      {plan.isOverdue && (
                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                          Overdue
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`text-sm ${HARVEST_TYPE_CONFIG[plan.harvestType].color}`}>
                        {HARVEST_TYPE_CONFIG[plan.harvestType].label}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{formatDate(plan.plannedDate)}</div>
                      {plan.daysUntilHarvest !== undefined && plan.daysUntilHarvest >= 0 && (
                        <div className="text-xs text-gray-500">{plan.daysUntilHarvest} days</div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <span className="text-sm font-medium text-gray-900">
                        {formatNumber(plan.estimates.estimatedBiomass)} kg
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      {plan.financialProjection ? (
                        <span className="text-sm font-medium text-green-600">
                          {formatCurrency(
                            plan.financialProjection.estimatedRevenue,
                            plan.financialProjection.currency,
                          )}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end gap-2">
                        {plan.canEdit && (
                          <button
                            onClick={() => setEditingPlan(plan)}
                            className="text-blue-600 hover:text-blue-900"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                        )}
                        {plan.canDelete && (
                          <button
                            onClick={() => setDeletingPlan(plan)}
                            className="text-red-600 hover:text-red-900"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredPlans.length === 0 && (
              <div className="text-center py-12">
                <FileText className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">No harvest plans found</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Get started by creating a new harvest plan.
                </p>
              </div>
            )}
          </div>
        )}

        {viewMode === 'kanban' && (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {KANBAN_COLUMNS.map((status) => (
              <div key={status} className="flex-shrink-0 w-80">
                <div className="bg-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={status} showIcon={true} />
                      <span className="text-xs text-gray-500">
                        ({plansByStatus[status].length})
                      </span>
                    </div>
                  </div>
                  <div className="space-y-3 max-h-[600px] overflow-y-auto">
                    {plansByStatus[status].map((plan) => (
                      <PlanCard
                        key={plan.id}
                        plan={plan}
                        onEdit={setEditingPlan}
                        onDelete={setDeletingPlan}
                        onWorkflowAction={handleWorkflowAction}
                        compact
                      />
                    ))}
                    {plansByStatus[status].length === 0 && (
                      <div className="text-center py-8 text-sm text-gray-400">No plans</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      <HarvestPlanFormModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSave={handleCreatePlan}
        batches={batches}
      />

      <HarvestPlanFormModal
        isOpen={!!editingPlan}
        onClose={() => setEditingPlan(null)}
        onSave={handleUpdatePlan}
        plan={editingPlan}
        batches={batches}
      />

      <ConfirmDeleteModal
        isOpen={!!deletingPlan}
        onClose={() => setDeletingPlan(null)}
        onConfirm={handleDeletePlan}
        plan={deletingPlan}
      />

      <CompleteHarvestModal
        isOpen={!!completingPlan}
        onClose={() => setCompletingPlan(null)}
        onComplete={handleComplete}
        plan={completingPlan}
      />

      <ScheduleModal
        isOpen={!!schedulingPlan}
        onClose={() => setSchedulingPlan(null)}
        onSchedule={handleSchedule}
        plan={schedulingPlan}
      />

      <PostponeModal
        isOpen={!!postponingPlan}
        onClose={() => setPostponingPlan(null)}
        onPostpone={handlePostpone}
        plan={postponingPlan}
      />
    </div>
  );
};

export default HarvestPlansPage;
