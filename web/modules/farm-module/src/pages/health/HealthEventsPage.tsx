/**
 * Health Events Page
 * Displays and manages fish health events with full CRUD, treatment, and quarantine operations
 */
import React, { useState, useMemo } from 'react';
import {
  Card,
  Button,
  Modal,
  Input,
  Select,
  Badge,
  Spinner,
  Alert,
} from '@aquaculture/shared-ui';
import {
  Activity,
  AlertTriangle,
  Shield,
  Pill,
  CheckCircle,
  Plus,
  Edit,
  Trash2,
  Play,
  Square,
  Search,
  Filter,
  Calendar,
  X,
} from 'lucide-react';
import {
  useHealthEvents,
  useHealthEventStats,
  useCreateHealthEvent,
  useUpdateHealthEvent,
  useDeleteHealthEvent,
  useStartHealthEventTreatment,
  useEndHealthEventTreatment,
  useStartHealthEventQuarantine,
  useEndHealthEventQuarantine,
  useResolveHealthEvent,
  HealthEvent,
  HealthEventType,
  HealthSeverity,
  HealthEventStatus,
  DiseaseCategory,
  TreatmentMethod,
  HealthEventFilter,
  CreateHealthEventInput,
} from '../../hooks/useHealthEvents';
import { isBlockingError } from '../../utils/list-view-state';

// ============================================================================
// CONSTANTS
// ============================================================================

const statusColors: Record<HealthEventStatus, string> = {
  active: 'bg-red-100 text-red-800',
  monitoring: 'bg-yellow-100 text-yellow-800',
  resolved: 'bg-green-100 text-green-800',
  chronic: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<HealthEventStatus, string> = {
  active: 'Active',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  chronic: 'Chronic',
  cancelled: 'Cancelled',
};

const severityColors: Record<HealthSeverity, string> = {
  minor: 'bg-blue-100 text-blue-800',
  moderate: 'bg-yellow-100 text-yellow-800',
  severe: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

const severityLabels: Record<HealthSeverity, string> = {
  minor: 'Minor',
  moderate: 'Moderate',
  severe: 'Severe',
  critical: 'Critical',
};

const eventTypeLabels: Record<HealthEventType, string> = {
  disease_outbreak: 'Disease Outbreak',
  symptom_observed: 'Symptom Observed',
  routine_inspection: 'Routine Inspection',
  treatment_start: 'Treatment Start',
  treatment_end: 'Treatment End',
  vaccination: 'Vaccination',
  quarantine_start: 'Quarantine Start',
  quarantine_end: 'Quarantine End',
  mortality_event: 'Mortality Event',
  recovery: 'Recovery',
  lab_result: 'Lab Result',
  vet_consultation: 'Vet Consultation',
};

const diseaseCategoryLabels: Record<DiseaseCategory, string> = {
  bacterial: 'Bacterial',
  viral: 'Viral',
  parasitic: 'Parasitic',
  fungal: 'Fungal',
  nutritional: 'Nutritional',
  environmental: 'Environmental',
  genetic: 'Genetic',
  unknown: 'Unknown',
};

const treatmentMethodLabels: Record<TreatmentMethod, string> = {
  bath: 'Bath Treatment',
  in_feed: 'In-Feed',
  injection: 'Injection',
  immersion: 'Immersion',
  topical: 'Topical',
  environmental: 'Environmental',
  vaccination: 'Vaccination',
};

// ============================================================================
// FORM DATA INTERFACES
// ============================================================================

interface HealthEventFormData {
  batchId: string;
  tankId: string;
  title: string;
  description: string;
  eventType: HealthEventType;
  eventDate: string;
  eventTime: string;
  diseaseCategory: DiseaseCategory;
  diseaseName: string;
  severity: HealthSeverity;
  affectedCount: number;
  mortalityCount: number;
  notes: string;
  followUpRequired: boolean;
  followUpDate: string;
}

const defaultFormData: HealthEventFormData = {
  batchId: '',
  tankId: '',
  title: '',
  description: '',
  eventType: 'symptom_observed',
  eventDate: new Date().toISOString().split('T')[0],
  eventTime: '',
  diseaseCategory: 'unknown',
  diseaseName: '',
  severity: 'moderate',
  affectedCount: 0,
  mortalityCount: 0,
  notes: '',
  followUpRequired: false,
  followUpDate: '',
};

interface TreatmentFormData {
  method: TreatmentMethod;
  medicationName: string;
  activeIngredient: string;
  dosage: number;
  dosageUnit: string;
  startDate: string;
  endDate: string;
  frequency: string;
  withdrawalPeriod: number;
  instructions: string;
}

const defaultTreatmentData: TreatmentFormData = {
  method: 'bath',
  medicationName: '',
  activeIngredient: '',
  dosage: 0,
  dosageUnit: 'mg/L',
  startDate: new Date().toISOString().split('T')[0],
  endDate: '',
  frequency: '1x daily',
  withdrawalPeriod: 0,
  instructions: '',
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const HealthEventsPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<HealthEventFilter>({
    limit: 50,
    offset: 0,
    sortBy: 'eventDate',
    sortDirection: 'DESC',
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<HealthEventFormData>(defaultFormData);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Treatment modal state
  const [isTreatmentModalOpen, setIsTreatmentModalOpen] = useState(false);
  const [treatmentData, setTreatmentData] = useState<TreatmentFormData>(defaultTreatmentData);
  const [selectedEventForTreatment, setSelectedEventForTreatment] = useState<HealthEvent | null>(null);

  // Quarantine modal state
  const [isQuarantineModalOpen, setIsQuarantineModalOpen] = useState(false);
  const [quarantineTankId, setQuarantineTankId] = useState('');
  const [selectedEventForQuarantine, setSelectedEventForQuarantine] = useState<HealthEvent | null>(null);

  // Resolution modal state
  const [isResolveModalOpen, setIsResolveModalOpen] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [selectedEventForResolve, setSelectedEventForResolve] = useState<HealthEvent | null>(null);

  // Detail view state
  const [selectedEventForDetail, setSelectedEventForDetail] = useState<HealthEvent | null>(null);

  // API hooks
  const { data, isLoading, error, refetch } = useHealthEvents(filter);
  const { data: stats } = useHealthEventStats();
  const createMutation = useCreateHealthEvent();
  const updateMutation = useUpdateHealthEvent();
  const deleteMutation = useDeleteHealthEvent();
  const startTreatmentMutation = useStartHealthEventTreatment();
  const endTreatmentMutation = useEndHealthEventTreatment();
  const startQuarantineMutation = useStartHealthEventQuarantine();
  const endQuarantineMutation = useEndHealthEventQuarantine();
  const resolveMutation = useResolveHealthEvent();

  // Filtered data by search term
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    if (!searchTerm) return data.items;
    const term = searchTerm.toLowerCase();
    return data.items.filter(
      (item) =>
        item.title.toLowerCase().includes(term) ||
        item.description?.toLowerCase().includes(term) ||
        item.diseaseName?.toLowerCase().includes(term) ||
        item.notes?.toLowerCase().includes(term)
    );
  }, [data?.items, searchTerm]);

  // =========================================================================
  // HANDLERS - Form
  // =========================================================================

  const handleOpenCreate = () => {
    setFormData(defaultFormData);
    setEditingId(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (event: HealthEvent) => {
    setFormData({
      batchId: event.batchId,
      tankId: event.tankId || '',
      title: event.title,
      description: event.description || '',
      eventType: event.eventType,
      eventDate: event.eventDate?.split('T')[0] || '',
      eventTime: event.eventTime || '',
      diseaseCategory: event.diseaseCategory || 'unknown',
      diseaseName: event.diseaseName || '',
      severity: event.severity,
      affectedCount: event.affectedPopulation?.estimatedAffected || 0,
      mortalityCount: event.affectedPopulation?.mortalityCount || 0,
      notes: event.notes || '',
      followUpRequired: event.followUpRequired,
      followUpDate: event.nextFollowUpDate?.split('T')[0] || '',
    });
    setEditingId(event.id);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          tankId: formData.tankId || undefined,
          title: formData.title,
          description: formData.description || undefined,
          eventType: formData.eventType,
          eventDate: formData.eventDate || undefined,
          eventTime: formData.eventTime || undefined,
          diseaseCategory: formData.diseaseCategory,
          diseaseName: formData.diseaseName || undefined,
          severity: formData.severity,
          affectedCount: formData.affectedCount || undefined,
          mortalityCount: formData.mortalityCount || undefined,
          notes: formData.notes || undefined,
          followUpRequired: formData.followUpRequired,
          followUpDate: formData.followUpDate || undefined,
        });
      } else {
        const input: CreateHealthEventInput = {
          batchId: formData.batchId,
          tankId: formData.tankId || undefined,
          title: formData.title,
          description: formData.description || undefined,
          eventType: formData.eventType,
          eventDate: formData.eventDate,
          eventTime: formData.eventTime || undefined,
          diseaseCategory: formData.diseaseCategory,
          diseaseName: formData.diseaseName || undefined,
          severity: formData.severity,
          affectedCount: formData.affectedCount || undefined,
          mortalityCount: formData.mortalityCount || undefined,
          notes: formData.notes || undefined,
          followUpRequired: formData.followUpRequired,
          followUpDate: formData.followUpDate || undefined,
          reportedBy: 'current-user', // This would come from auth context
        };
        await createMutation.mutateAsync(input);
      }
      setIsModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error saving health event:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this health event?')) {
      try {
        await deleteMutation.mutateAsync(id);
        refetch();
      } catch (err) {
        console.error('Error deleting health event:', err);
      }
    }
  };

  // =========================================================================
  // HANDLERS - Treatment
  // =========================================================================

  const handleOpenStartTreatment = (event: HealthEvent) => {
    setSelectedEventForTreatment(event);
    setTreatmentData(defaultTreatmentData);
    setIsTreatmentModalOpen(true);
  };

  const handleStartTreatment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventForTreatment) return;

    try {
      await startTreatmentMutation.mutateAsync({
        id: selectedEventForTreatment.id,
        treatment: {
          method: treatmentData.method,
          medication: treatmentData.medicationName
            ? {
                name: treatmentData.medicationName,
                activeIngredient: treatmentData.activeIngredient,
                dosage: treatmentData.dosage,
                dosageUnit: treatmentData.dosageUnit,
              }
            : undefined,
          duration: {
            startDate: treatmentData.startDate,
            endDate: treatmentData.endDate || undefined,
            frequency: treatmentData.frequency,
          },
          withdrawalPeriod: treatmentData.withdrawalPeriod || undefined,
          instructions: treatmentData.instructions || undefined,
        },
      });
      setIsTreatmentModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error starting treatment:', err);
    }
  };

  const handleEndTreatment = async (event: HealthEvent) => {
    if (window.confirm('Are you sure you want to end the treatment?')) {
      try {
        await endTreatmentMutation.mutateAsync({ id: event.id });
        refetch();
      } catch (err) {
        console.error('Error ending treatment:', err);
      }
    }
  };

  // =========================================================================
  // HANDLERS - Quarantine
  // =========================================================================

  const handleOpenStartQuarantine = (event: HealthEvent) => {
    setSelectedEventForQuarantine(event);
    setQuarantineTankId('');
    setIsQuarantineModalOpen(true);
  };

  const handleStartQuarantine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventForQuarantine) return;

    try {
      await startQuarantineMutation.mutateAsync({
        id: selectedEventForQuarantine.id,
        quarantineTankId: quarantineTankId || undefined,
      });
      setIsQuarantineModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error starting quarantine:', err);
    }
  };

  const handleEndQuarantine = async (event: HealthEvent) => {
    if (window.confirm('Are you sure you want to end the quarantine?')) {
      try {
        await endQuarantineMutation.mutateAsync(event.id);
        refetch();
      } catch (err) {
        console.error('Error ending quarantine:', err);
      }
    }
  };

  // =========================================================================
  // HANDLERS - Resolution
  // =========================================================================

  const handleOpenResolve = (event: HealthEvent) => {
    setSelectedEventForResolve(event);
    setResolutionNotes('');
    setIsResolveModalOpen(true);
  };

  const handleResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventForResolve) return;

    try {
      await resolveMutation.mutateAsync({
        id: selectedEventForResolve.id,
        notes: resolutionNotes || undefined,
      });
      setIsResolveModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error resolving health event:', err);
    }
  };

  // =========================================================================
  // HANDLERS - Filters
  // =========================================================================

  const handleFilterChange = (key: keyof HealthEventFilter, value: string) => {
    if (value === '') {
      const newFilter = { ...filter };
      delete newFilter[key];
      setFilter(newFilter);
    } else if (key === 'status') {
      setFilter({ ...filter, status: value as HealthEventStatus });
    } else if (key === 'severity') {
      setFilter({ ...filter, severity: value as HealthSeverity });
    } else if (key === 'eventType') {
      setFilter({ ...filter, eventType: value as HealthEventType });
    }
  };

  const handleDateFilterChange = (key: 'fromDate' | 'toDate', value: string) => {
    if (value === '') {
      const newFilter = { ...filter };
      delete newFilter[key];
      setFilter(newFilter);
    } else {
      setFilter({ ...filter, [key]: value });
    }
  };

  const clearFilters = () => {
    setFilter({
      limit: 50,
      offset: 0,
      sortBy: 'eventDate',
      sortDirection: 'DESC',
    });
    setSearchTerm('');
  };

  // =========================================================================
  // UTILS
  // =========================================================================

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // =========================================================================
  // RENDER
  // =========================================================================

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached data keeps rendering the list
  // and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="p-6">
        <Alert type="error">Error loading health events. Please try again.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded data visible. */}
      {error && (
        <Alert
          type="warning"
          action={{ label: 'Retry', onClick: () => refetch() }}
        >
          Couldn&apos;t refresh health events — showing the last loaded data.
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Health Events</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track and manage fish health events, treatments, and quarantine
          </p>
        </div>
        <Button onClick={handleOpenCreate} className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          New Health Event
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Activity className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <div className="text-sm text-gray-500">Total Events</div>
                <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <div className="text-sm text-gray-500">Active</div>
                <div className="text-2xl font-bold text-red-600">{stats.active}</div>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <div className="text-sm text-gray-500">Critical</div>
                <div className="text-2xl font-bold text-orange-600">{stats.critical}</div>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Pill className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <div className="text-sm text-gray-500">Under Treatment</div>
                <div className="text-2xl font-bold text-purple-600">{stats.underTreatment}</div>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Shield className="w-5 h-5 text-yellow-600" />
              </div>
              <div>
                <div className="text-sm text-gray-500">Quarantined</div>
                <div className="text-2xl font-bold text-yellow-600">{stats.quarantined}</div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="space-y-4">
          {/* Search and toggle */}
          <div className="flex items-center gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search events..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2"
            >
              <Filter className="w-4 h-4" />
              Filters
            </Button>
            {(filter.status || filter.severity || filter.eventType || filter.fromDate || filter.toDate) && (
              <Button variant="secondary" onClick={clearFilters} className="flex items-center gap-2">
                <X className="w-4 h-4" />
                Clear
              </Button>
            )}
          </div>

          {/* Extended filters */}
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4 pt-4 border-t border-gray-200">
              <Select
                value={filter.status || ''}
                onChange={(e) => handleFilterChange('status', e.target.value)}
                options={[
                  { value: '', label: 'All Statuses' },
                  ...Object.entries(statusLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <Select
                value={filter.severity || ''}
                onChange={(e) => handleFilterChange('severity', e.target.value)}
                options={[
                  { value: '', label: 'All Severities' },
                  ...Object.entries(severityLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <Select
                value={filter.eventType || ''}
                onChange={(e) => handleFilterChange('eventType', e.target.value)}
                options={[
                  { value: '', label: 'All Event Types' },
                  ...Object.entries(eventTypeLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-400" />
                <Input
                  type="date"
                  placeholder="From Date"
                  value={filter.fromDate || ''}
                  onChange={(e) => handleDateFilterChange('fromDate', e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-400" />
                <Input
                  type="date"
                  placeholder="To Date"
                  value={filter.toDate || ''}
                  onChange={(e) => handleDateFilterChange('toDate', e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Events Table */}
      <Card>
        {isLoading ? (
          <div className="flex justify-center items-center py-12">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Event
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Severity
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Flags
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      No health events found
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">{item.title}</div>
                        {item.diseaseName && (
                          <div className="text-sm text-gray-500">{item.diseaseName}</div>
                        )}
                        {item.description && (
                          <div className="text-xs text-gray-400 truncate max-w-xs">
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {eventTypeLabels[item.eventType]}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge className={statusColors[item.status]}>
                          {statusLabels[item.status]}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge className={severityColors[item.severity]}>
                          {severityLabels[item.severity]}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(item.eventDate)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {item.isUnderTreatment && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800"
                              title="Under Treatment"
                            >
                              <Pill className="w-3 h-3 mr-1" />
                              Rx
                            </span>
                          )}
                          {item.isQuarantined && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800"
                              title="Quarantined"
                            >
                              <Shield className="w-3 h-3 mr-1" />
                              Q
                            </span>
                          )}
                          {item.labConfirmed && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
                              title="Lab Confirmed"
                            >
                              Lab
                            </span>
                          )}
                          {item.followUpRequired && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800"
                              title="Follow-up Required"
                            >
                              F/U
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          {/* Treatment actions */}
                          {item.status !== 'resolved' && item.status !== 'cancelled' && (
                            <>
                              {!item.isUnderTreatment ? (
                                <button
                                  onClick={() => handleOpenStartTreatment(item)}
                                  className="text-purple-600 hover:text-purple-900"
                                  title="Start Treatment"
                                >
                                  <Play className="w-4 h-4" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleEndTreatment(item)}
                                  className="text-purple-600 hover:text-purple-900"
                                  title="End Treatment"
                                >
                                  <Square className="w-4 h-4" />
                                </button>
                              )}

                              {/* Quarantine actions */}
                              {!item.isQuarantined ? (
                                <button
                                  onClick={() => handleOpenStartQuarantine(item)}
                                  className="text-yellow-600 hover:text-yellow-900"
                                  title="Start Quarantine"
                                >
                                  <Shield className="w-4 h-4" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleEndQuarantine(item)}
                                  className="text-yellow-600 hover:text-yellow-900"
                                  title="End Quarantine"
                                >
                                  <Shield className="w-4 h-4 fill-current" />
                                </button>
                              )}

                              {/* Resolve */}
                              <button
                                onClick={() => handleOpenResolve(item)}
                                className="text-green-600 hover:text-green-900"
                                title="Resolve Event"
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                            </>
                          )}

                          {/* Edit */}
                          <button
                            onClick={() => handleOpenEdit(item)}
                            className="text-indigo-600 hover:text-indigo-900"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>

                          {/* Delete */}
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="text-red-600 hover:text-red-900"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination info */}
        {data && (
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              Showing {filteredItems.length} of {data.total} events
            </div>
            {data.hasNextPage && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setFilter({ ...filter, limit: (filter.limit || 50) + 50 })
                }
              >
                Load More
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Health Event' : 'New Health Event'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Batch ID"
              value={formData.batchId}
              onChange={(e) => setFormData({ ...formData, batchId: e.target.value })}
              required
              disabled={!!editingId}
            />
            <Input
              label="Tank ID (optional)"
              value={formData.tankId}
              onChange={(e) => setFormData({ ...formData, tankId: e.target.value })}
            />
          </div>
          <Input
            label="Title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            required
          />
          <Input
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Event Type"
              value={formData.eventType}
              onChange={(e) =>
                setFormData({ ...formData, eventType: e.target.value as HealthEventType })
              }
              options={Object.entries(eventTypeLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Select
              label="Severity"
              value={formData.severity}
              onChange={(e) =>
                setFormData({ ...formData, severity: e.target.value as HealthSeverity })
              }
              options={Object.entries(severityLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Event Date"
              type="date"
              value={formData.eventDate}
              onChange={(e) => setFormData({ ...formData, eventDate: e.target.value })}
              required
            />
            <Input
              label="Event Time (optional)"
              type="time"
              value={formData.eventTime}
              onChange={(e) => setFormData({ ...formData, eventTime: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Disease Category"
              value={formData.diseaseCategory}
              onChange={(e) =>
                setFormData({ ...formData, diseaseCategory: e.target.value as DiseaseCategory })
              }
              options={Object.entries(diseaseCategoryLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Input
              label="Disease Name (optional)"
              value={formData.diseaseName}
              onChange={(e) => setFormData({ ...formData, diseaseName: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Affected Count"
              type="number"
              value={formData.affectedCount}
              onChange={(e) =>
                setFormData({ ...formData, affectedCount: parseInt(e.target.value) || 0 })
              }
              min="0"
            />
            <Input
              label="Mortality Count"
              type="number"
              value={formData.mortalityCount}
              onChange={(e) =>
                setFormData({ ...formData, mortalityCount: parseInt(e.target.value) || 0 })
              }
              min="0"
            />
          </div>
          <Input
            label="Notes"
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="followUpRequired"
                checked={formData.followUpRequired}
                onChange={(e) =>
                  setFormData({ ...formData, followUpRequired: e.target.checked })
                }
                className="rounded border-gray-300"
              />
              <label htmlFor="followUpRequired" className="text-sm text-gray-700">
                Follow-up Required
              </label>
            </div>
            {formData.followUpRequired && (
              <Input
                label="Follow-up Date"
                type="date"
                value={formData.followUpDate}
                onChange={(e) => setFormData({ ...formData, followUpDate: e.target.value })}
              />
            )}
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending
                ? 'Saving...'
                : 'Save'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Treatment Modal */}
      <Modal
        isOpen={isTreatmentModalOpen}
        onClose={() => setIsTreatmentModalOpen(false)}
        title={`Start Treatment - ${selectedEventForTreatment?.title || ''}`}
      >
        <form onSubmit={handleStartTreatment} className="space-y-4">
          <Select
            label="Treatment Method"
            value={treatmentData.method}
            onChange={(e) =>
              setTreatmentData({ ...treatmentData, method: e.target.value as TreatmentMethod })
            }
            options={Object.entries(treatmentMethodLabels).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Medication Name"
              value={treatmentData.medicationName}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, medicationName: e.target.value })
              }
            />
            <Input
              label="Active Ingredient"
              value={treatmentData.activeIngredient}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, activeIngredient: e.target.value })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Dosage"
              type="number"
              step="0.01"
              value={treatmentData.dosage}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, dosage: parseFloat(e.target.value) || 0 })
              }
            />
            <Input
              label="Dosage Unit"
              value={treatmentData.dosageUnit}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, dosageUnit: e.target.value })
              }
              placeholder="mg/L, mg/kg, etc."
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Start Date"
              type="date"
              value={treatmentData.startDate}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, startDate: e.target.value })
              }
              required
            />
            <Input
              label="End Date (optional)"
              type="date"
              value={treatmentData.endDate}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, endDate: e.target.value })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Frequency"
              value={treatmentData.frequency}
              onChange={(e) =>
                setTreatmentData({ ...treatmentData, frequency: e.target.value })
              }
              placeholder="1x daily, every 12h, etc."
            />
            <Input
              label="Withdrawal Period (days)"
              type="number"
              value={treatmentData.withdrawalPeriod}
              onChange={(e) =>
                setTreatmentData({
                  ...treatmentData,
                  withdrawalPeriod: parseInt(e.target.value) || 0,
                })
              }
              min="0"
            />
          </div>
          <Input
            label="Instructions"
            value={treatmentData.instructions}
            onChange={(e) =>
              setTreatmentData({ ...treatmentData, instructions: e.target.value })
            }
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsTreatmentModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={startTreatmentMutation.isPending}>
              {startTreatmentMutation.isPending ? 'Starting...' : 'Start Treatment'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Quarantine Modal */}
      <Modal
        isOpen={isQuarantineModalOpen}
        onClose={() => setIsQuarantineModalOpen(false)}
        title={`Start Quarantine - ${selectedEventForQuarantine?.title || ''}`}
      >
        <form onSubmit={handleStartQuarantine} className="space-y-4">
          <Input
            label="Quarantine Tank ID (optional)"
            value={quarantineTankId}
            onChange={(e) => setQuarantineTankId(e.target.value)}
            placeholder="Leave empty for same location"
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsQuarantineModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={startQuarantineMutation.isPending}>
              {startQuarantineMutation.isPending ? 'Starting...' : 'Start Quarantine'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Resolve Modal */}
      <Modal
        isOpen={isResolveModalOpen}
        onClose={() => setIsResolveModalOpen(false)}
        title={`Resolve Event - ${selectedEventForResolve?.title || ''}`}
      >
        <form onSubmit={handleResolve} className="space-y-4">
          <Input
            label="Resolution Notes (optional)"
            value={resolutionNotes}
            onChange={(e) => setResolutionNotes(e.target.value)}
            placeholder="Describe the resolution..."
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsResolveModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={resolveMutation.isPending}>
              {resolveMutation.isPending ? 'Resolving...' : 'Resolve Event'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default HealthEventsPage;
