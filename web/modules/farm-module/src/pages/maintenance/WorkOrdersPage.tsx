/**
 * Work Orders Page
 * Displays and manages work orders for maintenance tracking
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
  useWorkOrders,
  useCreateWorkOrder,
  useUpdateWorkOrder,
  useDeleteWorkOrder,
  WorkOrder,
  WorkOrderStatus,
  WorkOrderPriority,
  WorkOrderType,
  WorkOrderFilter,
  CreateWorkOrderInput,
} from '../../hooks/useMaintenance';

// Status colors
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

// Priority colors
const priorityColors: Record<WorkOrderPriority, string> = {
  LOW: 'bg-gray-100 text-gray-800',
  MEDIUM: 'bg-blue-100 text-blue-800',
  HIGH: 'bg-orange-100 text-orange-800',
  CRITICAL: 'bg-red-100 text-red-800',
};

// Status labels
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

// Priority labels
const priorityLabels: Record<WorkOrderPriority, string> = {
  LOW: 'Düşük',
  MEDIUM: 'Orta',
  HIGH: 'Yüksek',
  CRITICAL: 'Kritik',
};

// Type labels
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

export const WorkOrdersPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<WorkOrderFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<WorkOrderFormData>(defaultFormData);
  const [editingId, setEditingId] = useState<string | null>(null);

  // API hooks
  const { data, isLoading, error, refetch } = useWorkOrders(filter, page, 20);
  const createMutation = useCreateWorkOrder();
  const updateMutation = useUpdateWorkOrder();
  const deleteMutation = useDeleteWorkOrder();

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

  // Handlers
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
      }
      setIsModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error saving work order:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Bu iş emrini silmek istediğinizden emin misiniz?')) {
      try {
        await deleteMutation.mutateAsync(id);
        refetch();
      } catch (err) {
        console.error('Error deleting work order:', err);
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

  // Format date
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('tr-TR');
  };

  if (error) {
    return (
      <div className="p-6">
        <Alert type="error">İş emirleri yüklenirken bir hata oluştu.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
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

      {/* Table */}
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
                    <tr key={item.id} className="hover:bg-gray-50">
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
                          onClick={() => handleOpenEdit(item)}
                          className="text-indigo-600 hover:text-indigo-900 mr-4"
                        >
                          Düzenle
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
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
    </div>
  );
};

export default WorkOrdersPage;
