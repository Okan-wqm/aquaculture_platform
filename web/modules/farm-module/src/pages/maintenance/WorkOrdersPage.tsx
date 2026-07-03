/**
 * Work Orders Page
 * Displays and manages work orders for maintenance tracking.
 * Includes full lifecycle workflow: submit, approve, start, verify, cancel, hold, resume.
 */
import React, { useState, useMemo, useCallback } from 'react';
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
  useWorkOrders,
  useCreateWorkOrder,
  useUpdateWorkOrder,
  useCompleteWorkOrder,
  useDeleteWorkOrder,
  useSubmitWorkOrderForApproval,
  useApproveWorkOrder,
  useStartWorkOrder,
  useVerifyWorkOrder,
  useCancelWorkOrder,
  usePutWorkOrderOnHold,
  useResumeWorkOrder,
  WorkOrder,
  WorkOrderStatus,
  WorkOrderPriority,
  WorkOrderType,
  WorkOrderFilter,
  CreateWorkOrderInput,
} from '../../hooks/useMaintenance';
import { isBlockingError } from '../../utils/list-view-state';

// ============================================================================
// CONSTANTS
// ============================================================================

const statusColors: Record<WorkOrderStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  PENDING_APPROVAL: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  SCHEDULED: 'bg-indigo-100 text-indigo-800',
  IN_PROGRESS: 'bg-purple-100 text-purple-800',
  ON_HOLD: 'bg-orange-100 text-orange-800',
  COMPLETED: 'bg-green-100 text-green-800',
  VERIFIED: 'bg-teal-100 text-teal-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

const priorityColors: Record<WorkOrderPriority, string> = {
  LOW: 'bg-gray-100 text-gray-800',
  MEDIUM: 'bg-blue-100 text-blue-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-red-100 text-red-800',
};

const statusLabels: Record<WorkOrderStatus, string> = {
  DRAFT: 'Taslak',
  PENDING_APPROVAL: 'Onay Bekliyor',
  APPROVED: 'Onaylandı',
  SCHEDULED: 'Planlandı',
  IN_PROGRESS: 'Devam Ediyor',
  ON_HOLD: 'Beklemede',
  COMPLETED: 'Tamamlandı',
  VERIFIED: 'Doğrulandı',
  CANCELLED: 'İptal',
};

const priorityLabels: Record<WorkOrderPriority, string> = {
  LOW: 'Düşük',
  MEDIUM: 'Orta',
  HIGH: 'Yüksek',
  CRITICAL: 'Kritik',
};

const typeLabels: Record<WorkOrderType, string> = {
  PREVENTIVE: 'Önleyici',
  CORRECTIVE: 'Düzeltici',
  EMERGENCY: 'Acil',
  INSPECTION: 'Muayene',
  CALIBRATION: 'Kalibrasyon',
  CLEANING: 'Temizlik',
  INSTALLATION: 'Kurulum',
  UPGRADE: 'Yükseltme',
  ROUTINE: 'Rutin',
};

// ============================================================================
// TYPES
// ============================================================================

interface WorkOrderFormData {
  title: string;
  description: string;
  type: WorkOrderType;
  priority: WorkOrderPriority;
  dueDate: string;
  estimatedDurationMinutes: number;
  notes: string;
}

const defaultFormData: WorkOrderFormData = {
  title: '',
  description: '',
  type: 'ROUTINE',
  priority: 'MEDIUM',
  dueDate: '',
  estimatedDurationMinutes: 60,
  notes: '',
};

type WorkflowAction =
  | 'submit'
  | 'approve'
  | 'start'
  | 'complete'
  | 'verify'
  | 'cancel'
  | 'hold'
  | 'resume';

interface WorkflowActionDef {
  action: WorkflowAction;
  label: string;
  color: string;
  bgColor: string;
  hoverColor: string;
  needsReason: boolean;
  confirmMessage?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Returns available workflow actions based on the current work order status.
 */
function getAvailableActions(status: WorkOrderStatus): WorkflowActionDef[] {
  const actions: WorkflowActionDef[] = [];

  switch (status) {
    case 'DRAFT':
      actions.push({
        action: 'submit',
        label: 'Onaya Gönder',
        color: 'text-blue-700',
        bgColor: 'bg-blue-50',
        hoverColor: 'hover:bg-blue-100',
        needsReason: false,
      });
      break;

    case 'PENDING_APPROVAL':
      actions.push({
        action: 'approve',
        label: 'Onayla',
        color: 'text-green-700',
        bgColor: 'bg-green-50',
        hoverColor: 'hover:bg-green-100',
        needsReason: false,
      });
      actions.push({
        action: 'cancel',
        label: 'İptal Et',
        color: 'text-red-700',
        bgColor: 'bg-red-50',
        hoverColor: 'hover:bg-red-100',
        needsReason: true,
        confirmMessage: 'Bu iş emrini iptal etmek istediğinizden emin misiniz?',
      });
      break;

    case 'APPROVED':
    case 'SCHEDULED':
      actions.push({
        action: 'start',
        label: 'Başlat',
        color: 'text-purple-700',
        bgColor: 'bg-purple-50',
        hoverColor: 'hover:bg-purple-100',
        needsReason: false,
      });
      actions.push({
        action: 'cancel',
        label: 'İptal Et',
        color: 'text-red-700',
        bgColor: 'bg-red-50',
        hoverColor: 'hover:bg-red-100',
        needsReason: true,
        confirmMessage: 'Bu iş emrini iptal etmek istediğinizden emin misiniz?',
      });
      break;

    case 'IN_PROGRESS':
      actions.push({
        action: 'complete',
        label: 'Tamamla',
        color: 'text-green-700',
        bgColor: 'bg-green-50',
        hoverColor: 'hover:bg-green-100',
        needsReason: false,
      });
      actions.push({
        action: 'hold',
        label: 'Beklet',
        color: 'text-orange-700',
        bgColor: 'bg-orange-50',
        hoverColor: 'hover:bg-orange-100',
        needsReason: true,
        confirmMessage: 'Bu iş emrini beklemeye almak istediğinizden emin misiniz?',
      });
      actions.push({
        action: 'cancel',
        label: 'İptal Et',
        color: 'text-red-700',
        bgColor: 'bg-red-50',
        hoverColor: 'hover:bg-red-100',
        needsReason: true,
        confirmMessage: 'Bu iş emrini iptal etmek istediğinizden emin misiniz?',
      });
      break;

    case 'ON_HOLD':
      actions.push({
        action: 'resume',
        label: 'Devam Et',
        color: 'text-purple-700',
        bgColor: 'bg-purple-50',
        hoverColor: 'hover:bg-purple-100',
        needsReason: false,
      });
      actions.push({
        action: 'cancel',
        label: 'İptal Et',
        color: 'text-red-700',
        bgColor: 'bg-red-50',
        hoverColor: 'hover:bg-red-100',
        needsReason: true,
        confirmMessage: 'Bu iş emrini iptal etmek istediğinizden emin misiniz?',
      });
      break;

    case 'COMPLETED':
      actions.push({
        action: 'verify',
        label: 'Doğrula',
        color: 'text-teal-700',
        bgColor: 'bg-teal-50',
        hoverColor: 'hover:bg-teal-100',
        needsReason: false,
      });
      break;

    // VERIFIED and CANCELLED are terminal states - no actions
    default:
      break;
  }

  return actions;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('tr-TR');
}

function formatDateTime(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR');
}

// ============================================================================
// COMPONENT
// ============================================================================

export const WorkOrdersPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<WorkOrderFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<WorkOrderFormData>(defaultFormData);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Detail panel state
  const [selectedWorkOrder, setSelectedWorkOrder] = useState<WorkOrder | null>(null);

  // Confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<{
    workOrder: WorkOrder;
    actionDef: WorkflowActionDef;
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionNotes, setActionNotes] = useState('');

  // Success/Error feedback
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // API hooks - existing
  const { data, isLoading, error, refetch } = useWorkOrders(filter, page, 20);
  const createMutation = useCreateWorkOrder();
  const updateMutation = useUpdateWorkOrder();
  const completeMutation = useCompleteWorkOrder();
  const deleteMutation = useDeleteWorkOrder();

  // API hooks - lifecycle
  const submitForApprovalMutation = useSubmitWorkOrderForApproval();
  const approveMutation = useApproveWorkOrder();
  const startMutation = useStartWorkOrder();
  const verifyMutation = useVerifyWorkOrder();
  const cancelMutation = useCancelWorkOrder();
  const holdMutation = usePutWorkOrderOnHold();
  const resumeMutation = useResumeWorkOrder();

  // Any lifecycle mutation pending?
  const isLifecyclePending =
    submitForApprovalMutation.isPending ||
    approveMutation.isPending ||
    startMutation.isPending ||
    completeMutation.isPending ||
    verifyMutation.isPending ||
    cancelMutation.isPending ||
    holdMutation.isPending ||
    resumeMutation.isPending;

  // Filtered data
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    if (!searchTerm) return data.items;
    const term = searchTerm.toLowerCase();
    return data.items.filter(
      (item) =>
        item.title.toLowerCase().includes(term) ||
        item.workOrderCode.toLowerCase().includes(term) ||
        item.description?.toLowerCase().includes(term)
    );
  }, [data?.items, searchTerm]);

  // Show feedback temporarily
  const showFeedback = useCallback((type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 4000);
  }, []);

  // -------------------------------------------------------------------------
  // HANDLERS - CRUD
  // -------------------------------------------------------------------------

  const handleOpenCreate = () => {
    setFormData(defaultFormData);
    setEditingId(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (workOrder: WorkOrder) => {
    setFormData({
      title: workOrder.title,
      description: workOrder.description || '',
      type: workOrder.type,
      priority: workOrder.priority,
      dueDate: workOrder.dueDate?.split('T')[0] || '',
      estimatedDurationMinutes: workOrder.estimatedDurationMinutes || 60,
      notes: workOrder.notes || '',
    });
    setEditingId(workOrder.id);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          title: formData.title,
          description: formData.description || undefined,
          type: formData.type,
          priority: formData.priority,
          dueDate: formData.dueDate || undefined,
          estimatedDurationMinutes: formData.estimatedDurationMinutes,
          notes: formData.notes || undefined,
        });
        showFeedback('success', 'İş emri güncellendi.');
      } else {
        const input: CreateWorkOrderInput = {
          title: formData.title,
          description: formData.description || undefined,
          type: formData.type,
          priority: formData.priority,
          dueDate: formData.dueDate || undefined,
          estimatedDurationMinutes: formData.estimatedDurationMinutes,
          notes: formData.notes || undefined,
        };
        await createMutation.mutateAsync(input);
        showFeedback('success', 'İş emri oluşturuldu.');
      }
      setIsModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error saving work order:', err);
      showFeedback('error', 'İş emri kaydedilirken bir hata oluştu.');
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Bu iş emrini silmek istediğinizden emin misiniz?')) {
      try {
        await deleteMutation.mutateAsync(id);
        if (selectedWorkOrder?.id === id) {
          setSelectedWorkOrder(null);
        }
        showFeedback('success', 'İş emri silindi.');
        refetch();
      } catch (err) {
        console.error('Error deleting work order:', err);
        showFeedback('error', 'İş emri silinirken bir hata oluştu.');
      }
    }
  };

  const handleFilterChange = (key: keyof WorkOrderFilter, value: string) => {
    if (value === '') {
      const newFilter = { ...filter };
      delete newFilter[key];
      setFilter(newFilter);
    } else if (key === 'status') {
      setFilter({ ...filter, status: [value as WorkOrderStatus] });
    } else if (key === 'priority') {
      setFilter({ ...filter, priority: [value as WorkOrderPriority] });
    }
    setPage(1);
  };

  // -------------------------------------------------------------------------
  // HANDLERS - LIFECYCLE WORKFLOW
  // -------------------------------------------------------------------------

  const handleWorkflowAction = useCallback(
    (workOrder: WorkOrder, actionDef: WorkflowActionDef) => {
      if (actionDef.needsReason || actionDef.confirmMessage) {
        // Show confirmation dialog
        setConfirmAction({ workOrder, actionDef });
        setActionReason('');
        setActionNotes('');
      } else {
        // Execute immediately
        executeWorkflowAction(workOrder, actionDef.action, '', '');
      }
    },
    []
  );

  const executeWorkflowAction = useCallback(
    async (workOrder: WorkOrder, action: WorkflowAction, reason: string, notes: string) => {
      try {
        switch (action) {
          case 'submit':
            await submitForApprovalMutation.mutateAsync(workOrder.id);
            showFeedback('success', 'İş emri onaya gönderildi.');
            break;

          case 'approve':
            await approveMutation.mutateAsync({
              id: workOrder.id,
              approvalNotes: notes || undefined,
            });
            showFeedback('success', 'İş emri onaylandı.');
            break;

          case 'start':
            await startMutation.mutateAsync({
              id: workOrder.id,
              notes: notes || undefined,
            });
            showFeedback('success', 'İş emri başlatıldı.');
            break;

          case 'complete':
            await completeMutation.mutateAsync({
              id: workOrder.id,
              completionNotes: notes || undefined,
            });
            showFeedback('success', 'İş emri tamamlandı.');
            break;

          case 'verify':
            await verifyMutation.mutateAsync({
              id: workOrder.id,
              verificationNotes: notes || undefined,
              approved: true,
            });
            showFeedback('success', 'İş emri doğrulandı.');
            break;

          case 'cancel':
            await cancelMutation.mutateAsync({
              id: workOrder.id,
              reason: reason || undefined,
            });
            showFeedback('success', 'İş emri iptal edildi.');
            break;

          case 'hold':
            await holdMutation.mutateAsync({
              id: workOrder.id,
              reason: reason || undefined,
            });
            showFeedback('success', 'İş emri beklemeye alındı.');
            break;

          case 'resume':
            await resumeMutation.mutateAsync(workOrder.id);
            showFeedback('success', 'İş emri devam ettirildi.');
            break;
        }

        // Refresh detail if selected
        if (selectedWorkOrder?.id === workOrder.id) {
          // Update the selected work order from the refetched list
          refetch().then((result) => {
            const updated = result.data?.items.find((i) => i.id === workOrder.id);
            if (updated) setSelectedWorkOrder(updated);
          });
        } else {
          refetch();
        }
      } catch (err) {
        console.error(`Error executing ${action}:`, err);
        showFeedback('error', `İşlem sırasında bir hata oluştu.`);
      }

      setConfirmAction(null);
    },
    [
      submitForApprovalMutation,
      approveMutation,
      startMutation,
      completeMutation,
      verifyMutation,
      cancelMutation,
      holdMutation,
      resumeMutation,
      selectedWorkOrder,
      refetch,
      showFeedback,
    ]
  );

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    executeWorkflowAction(
      confirmAction.workOrder,
      confirmAction.actionDef.action,
      actionReason,
      actionNotes
    );
  };

  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached data keeps rendering the list
  // and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="p-6">
        <Alert type="error">İş emirleri yüklenirken bir hata oluştu.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded data visible. */}
      {error && (
        <Alert
          type="warning"
          action={{ label: 'Yeniden Dene', onClick: () => refetch() }}
        >
          İş emirleri yenilenemedi — son yüklenen veriler gösteriliyor.
        </Alert>
      )}

      {/* Feedback Alert */}
      {feedback && (
        <Alert type={feedback.type}>
          {feedback.message}
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">İş Emirleri</h1>
          <p className="text-sm text-gray-500 mt-1">
            Bakım iş emirlerini görüntüleyin ve yönetin
          </p>
        </div>
        <Button onClick={handleOpenCreate}>Yeni İş Emri</Button>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Input
            placeholder="Ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <Select
            value={filter.status?.[0] || ''}
            onChange={(e) => handleFilterChange('status', e.target.value)}
            options={[
              { value: '', label: 'Tüm Durumlar' },
              ...Object.entries(statusLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <Select
            value={filter.priority?.[0] || ''}
            onChange={(e) => handleFilterChange('priority', e.target.value)}
            options={[
              { value: '', label: 'Tüm Öncelikler' },
              ...Object.entries(priorityLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </div>
      </Card>

      {/* Main Content: Table + Detail Panel */}
      <div className={`grid gap-6 ${selectedWorkOrder ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1'}`}>
        {/* Table */}
        <Card className={selectedWorkOrder ? 'lg:col-span-2' : ''}>
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
                      Kod / Başlık
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Tip
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Durum
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Öncelik
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Bitiş Tarihi
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      İşlemler
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                        Henüz iş emri bulunmuyor
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map((item) => (
                      <tr
                        key={item.id}
                        className={`hover:bg-gray-50 cursor-pointer ${
                          selectedWorkOrder?.id === item.id ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => setSelectedWorkOrder(item)}
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">
                            {item.workOrderCode}
                          </div>
                          <div className="text-sm text-gray-500">{item.title}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {typeLabels[item.type]}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge className={statusColors[item.status]}>
                            {statusLabels[item.status]}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge className={priorityColors[item.priority]}>
                            {priorityLabels[item.priority]}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {formatDate(item.dueDate)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEdit(item);
                            }}
                            className="text-indigo-600 hover:text-indigo-900 mr-4"
                          >
                            Düzenle
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(item.id);
                            }}
                            className="text-red-600 hover:text-red-900"
                          >
                            Sil
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Toplam {data.total} kayıt, Sayfa {data.page} / {data.totalPages}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Önceki
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!data.hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Sonraki
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Detail Panel */}
        {selectedWorkOrder && (
          <Card className="lg:col-span-1">
            <div className="p-6 space-y-6">
              {/* Detail Header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedWorkOrder.workOrderCode}
                  </h2>
                  <p className="text-sm text-gray-600 mt-1">{selectedWorkOrder.title}</p>
                </div>
                <button
                  onClick={() => setSelectedWorkOrder(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Status & Priority */}
              <div className="flex gap-2">
                <Badge className={statusColors[selectedWorkOrder.status]}>
                  {statusLabels[selectedWorkOrder.status]}
                </Badge>
                <Badge className={priorityColors[selectedWorkOrder.priority]}>
                  {priorityLabels[selectedWorkOrder.priority]}
                </Badge>
              </div>

              {/* Workflow Actions */}
              {(() => {
                const actions = getAvailableActions(selectedWorkOrder.status);
                if (actions.length === 0) return null;
                return (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-gray-700">İş Akışı</h3>
                    <div className="flex flex-wrap gap-2">
                      {actions.map((actionDef) => (
                        <button
                          key={actionDef.action}
                          onClick={() => handleWorkflowAction(selectedWorkOrder, actionDef)}
                          disabled={isLifecyclePending}
                          className={`inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium
                            ${actionDef.bgColor} ${actionDef.color} ${actionDef.hoverColor}
                            disabled:opacity-50 disabled:cursor-not-allowed
                            transition-colors duration-150`}
                        >
                          {isLifecyclePending ? (
                            <Spinner size="sm" />
                          ) : (
                            actionDef.label
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Detail Info */}
              <div className="space-y-3 border-t border-gray-200 pt-4">
                <DetailRow label="Tip" value={typeLabels[selectedWorkOrder.type]} />
                {selectedWorkOrder.description && (
                  <DetailRow label="Açıklama" value={selectedWorkOrder.description} />
                )}
                <DetailRow label="Bitiş Tarihi" value={formatDate(selectedWorkOrder.dueDate)} />
                <DetailRow
                  label="Tahmini Süre"
                  value={
                    selectedWorkOrder.estimatedDurationMinutes
                      ? `${selectedWorkOrder.estimatedDurationMinutes} dk`
                      : '-'
                  }
                />
                {selectedWorkOrder.actualStartTime && (
                  <DetailRow label="Başlangıç Zamanı" value={formatDateTime(selectedWorkOrder.actualStartTime)} />
                )}
                {selectedWorkOrder.actualEndTime && (
                  <DetailRow label="Bitiş Zamanı" value={formatDateTime(selectedWorkOrder.actualEndTime)} />
                )}
                {selectedWorkOrder.actualDurationMinutes != null && (
                  <DetailRow label="Gerçek Süre" value={`${selectedWorkOrder.actualDurationMinutes} dk`} />
                )}
                {selectedWorkOrder.approvedBy && (
                  <DetailRow label="Onaylayan" value={selectedWorkOrder.approvedBy} />
                )}
                {selectedWorkOrder.approvedAt && (
                  <DetailRow label="Onay Tarihi" value={formatDateTime(selectedWorkOrder.approvedAt)} />
                )}
                {selectedWorkOrder.completedBy && (
                  <DetailRow label="Tamamlayan" value={selectedWorkOrder.completedBy} />
                )}
                {selectedWorkOrder.completedAt && (
                  <DetailRow label="Tamamlanma Tarihi" value={formatDateTime(selectedWorkOrder.completedAt)} />
                )}
                {selectedWorkOrder.verifiedBy && (
                  <DetailRow label="Doğrulayan" value={selectedWorkOrder.verifiedBy} />
                )}
                {selectedWorkOrder.verifiedAt && (
                  <DetailRow label="Doğrulama Tarihi" value={formatDateTime(selectedWorkOrder.verifiedAt)} />
                )}
                {selectedWorkOrder.completionNotes && (
                  <DetailRow label="Tamamlama Notu" value={selectedWorkOrder.completionNotes} />
                )}
                {selectedWorkOrder.notes && (
                  <DetailRow label="Notlar" value={selectedWorkOrder.notes} />
                )}
                <DetailRow label="Oluşturulma" value={formatDateTime(selectedWorkOrder.createdAt)} />
                <DetailRow label="Son Güncelleme" value={formatDateTime(selectedWorkOrder.updatedAt)} />
              </div>

              {/* Checklist Progress */}
              {selectedWorkOrder.checklistProgress != null && (
                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">
                    Kontrol Listesi İlerlemesi
                  </h3>
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div
                      className="bg-blue-600 h-2.5 rounded-full"
                      style={{ width: `${selectedWorkOrder.checklistProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    %{Math.round(selectedWorkOrder.checklistProgress)} tamamlandı
                  </p>
                </div>
              )}

              {/* Cost Summary */}
              {selectedWorkOrder.costSummary && (
                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Maliyet Özeti</h3>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">İşçilik</span>
                      <span>{selectedWorkOrder.costSummary.laborCost.toLocaleString('tr-TR')} {selectedWorkOrder.costSummary.currency}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Malzeme</span>
                      <span>{selectedWorkOrder.costSummary.materialCost.toLocaleString('tr-TR')} {selectedWorkOrder.costSummary.currency}</span>
                    </div>
                    <div className="flex justify-between font-medium border-t pt-1">
                      <span className="text-gray-700">Toplam</span>
                      <span>{selectedWorkOrder.costSummary.totalCost.toLocaleString('tr-TR')} {selectedWorkOrder.costSummary.currency}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Quick Actions */}
              <div className="border-t border-gray-200 pt-4 flex gap-2">
                {selectedWorkOrder.status === 'DRAFT' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleOpenEdit(selectedWorkOrder)}
                  >
                    Düzenle
                  </Button>
                )}
                {(selectedWorkOrder.status === 'DRAFT' || selectedWorkOrder.status === 'CANCELLED') && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDelete(selectedWorkOrder.id)}
                    className="text-red-600"
                  >
                    Sil
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'İş Emri Düzenle' : 'Yeni İş Emri'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Başlık"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            required
          />
          <Input
            label="Açıklama"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Tip"
              value={formData.type}
              onChange={(e) =>
                setFormData({ ...formData, type: e.target.value as WorkOrderType })
              }
              options={Object.entries(typeLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Select
              label="Öncelik"
              value={formData.priority}
              onChange={(e) =>
                setFormData({ ...formData, priority: e.target.value as WorkOrderPriority })
              }
              options={Object.entries(priorityLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Bitiş Tarihi"
              type="date"
              value={formData.dueDate}
              onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
            />
            <Input
              label="Tahmini Süre (dk)"
              type="number"
              value={formData.estimatedDurationMinutes}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  estimatedDurationMinutes: parseInt(e.target.value) || 0,
                })
              }
            />
          </div>
          <Input
            label="Notlar"
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              İptal
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending
                ? 'Kaydediliyor...'
                : 'Kaydet'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Confirmation Dialog for Destructive/Reason Actions */}
      <Modal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.actionDef.label || ''}
      >
        <div className="space-y-4">
          {/* Confirmation Message */}
          {confirmAction?.actionDef.confirmMessage && (
            <div className="flex items-start gap-3 p-3 bg-yellow-50 rounded-lg">
              <svg className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-sm text-yellow-800">
                {confirmAction.actionDef.confirmMessage}
              </p>
            </div>
          )}

          {/* Work Order Info */}
          {confirmAction && (
            <div className="text-sm text-gray-600">
              <span className="font-medium">{confirmAction.workOrder.workOrderCode}</span>
              {' - '}
              {confirmAction.workOrder.title}
            </div>
          )}

          {/* Reason Input (for cancel and hold) */}
          {confirmAction?.actionDef.needsReason && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sebep {confirmAction.actionDef.action === 'cancel' ? '(opsiyonel)' : '(opsiyonel)'}
              </label>
              <textarea
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                rows={3}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder={
                  confirmAction.actionDef.action === 'cancel'
                    ? 'İptal sebebini belirtin...'
                    : 'Beklemeye alma sebebini belirtin...'
                }
              />
            </div>
          )}

          {/* Notes Input (for approve, start, verify) */}
          {!confirmAction?.actionDef.needsReason && confirmAction?.actionDef.action !== 'submit' && confirmAction?.actionDef.action !== 'resume' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Not (opsiyonel)
              </label>
              <textarea
                value={actionNotes}
                onChange={(e) => setActionNotes(e.target.value)}
                rows={2}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Ek not ekleyin..."
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setConfirmAction(null)}>
              Vazgeç
            </Button>
            <Button
              onClick={handleConfirmAction}
              disabled={isLifecyclePending}
              className={
                confirmAction?.actionDef.action === 'cancel'
                  ? 'bg-red-600 hover:bg-red-700'
                  : confirmAction?.actionDef.action === 'hold'
                    ? 'bg-orange-600 hover:bg-orange-700'
                    : ''
              }
            >
              {isLifecyclePending ? 'İşleniyor...' : confirmAction?.actionDef.label}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const DetailRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-xs font-medium text-gray-500">{label}</dt>
    <dd className="text-sm text-gray-900 mt-0.5">{value}</dd>
  </div>
);

export default WorkOrdersPage;
