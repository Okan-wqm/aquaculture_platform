/**
 * Maintenance Schedules Page
 * Displays and manages preventive maintenance schedules with full CRUD operations
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
  useMaintenanceSchedules,
  useCreateMaintenanceSchedule,
  useUpdateMaintenanceSchedule,
  useDeleteMaintenanceSchedule,
  usePauseMaintenanceSchedule,
  useResumeMaintenanceSchedule,
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
  MaintenanceCategory,
  RecurrenceType,
  MaintenanceScheduleFilter,
  CreateMaintenanceScheduleInput,
} from '../../hooks/useMaintenance';
import { isBlockingError } from '../../utils/list-view-state';
import GenerateWorkOrderButton from './components/GenerateWorkOrderButton';
import CompleteMaintenanceModal from './components/CompleteMaintenanceModal';
import ProcessAutoGenerateButton from './components/ProcessAutoGenerateButton';
import UpdateMeterReadingButton from './components/UpdateMeterReadingButton';
import { useCanMutate } from '@aquaculture/shared-ui';

// Status colors
const statusColors: Record<MaintenanceScheduleStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  PAUSED: 'bg-yellow-100 text-yellow-800',
  COMPLETED: 'bg-blue-100 text-blue-800',
  EXPIRED: 'bg-gray-100 text-gray-800',
};

// Status labels
const statusLabels: Record<MaintenanceScheduleStatus, string> = {
  ACTIVE: 'Aktif',
  PAUSED: 'Duraklatıldı',
  COMPLETED: 'Tamamlandı',
  EXPIRED: 'Süresi Doldu',
};

// Category labels
const categoryLabels: Record<MaintenanceCategory, string> = {
  MECHANICAL: 'Mekanik',
  ELECTRICAL: 'Elektrik',
  PLUMBING: 'Tesisat',
  CLEANING: 'Temizlik',
  LUBRICATION: 'Yağlama',
  INSPECTION: 'Muayene',
  CALIBRATION: 'Kalibrasyon',
  FILTER_CHANGE: 'Filtre Değişimi',
  SAFETY: 'Güvenlik',
  GENERAL: 'Genel',
};

// Recurrence type labels
const recurrenceLabels: Record<RecurrenceType, string> = {
  DAILY: 'Günlük',
  WEEKLY: 'Haftalık',
  BIWEEKLY: 'İki Haftada Bir',
  MONTHLY: 'Aylık',
  QUARTERLY: 'Üç Ayda Bir',
  SEMIANNUALLY: 'Altı Ayda Bir',
  ANNUALLY: 'Yıllık',
  CUSTOM: 'Özel',
  METER_BASED: 'Sayaç Bazlı',
};

interface ScheduleFormData {
  name: string;
  description: string;
  category: MaintenanceCategory;
  recurrenceType: RecurrenceType;
  recurrenceInterval: number;
  startDate: string;
  endDate: string;
  estimatedDurationMinutes: number;
  estimatedCost: number;
  currency: string;
  instructions: string;
  autoGenerateWorkOrder: boolean;
  generateDaysBefore: number;
  notes: string;
}

const defaultFormData: ScheduleFormData = {
  name: '',
  description: '',
  category: 'GENERAL',
  recurrenceType: 'MONTHLY',
  recurrenceInterval: 1,
  startDate: '',
  endDate: '',
  estimatedDurationMinutes: 60,
  estimatedCost: 0,
  currency: 'TRY',
  instructions: '',
  autoGenerateWorkOrder: true,
  generateDaysBefore: 7,
  notes: '',
};

export const MaintenanceSchedulesPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<MaintenanceScheduleFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<ScheduleFormData>(defaultFormData);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Bakım Kapanışı (completeMaintenance) modal state — separate from the
  // edit modal because the surfaces don't overlap in semantics.
  const [completingSchedule, setCompletingSchedule] =
    useState<MaintenanceSchedule | null>(null);
  const canCompleteMaintenance = useCanMutate('completeMaintenance');

  // API hooks
  const { data, isLoading, error, refetch } = useMaintenanceSchedules(filter, page, 20);
  const createMutation = useCreateMaintenanceSchedule();
  const updateMutation = useUpdateMaintenanceSchedule();
  const deleteMutation = useDeleteMaintenanceSchedule();
  const pauseMutation = usePauseMaintenanceSchedule();
  const resumeMutation = useResumeMaintenanceSchedule();

  // Filtered data
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    if (!searchTerm) return data.items;
    const term = searchTerm.toLowerCase();
    return data.items.filter(
      (item) =>
        item.name.toLowerCase().includes(term) ||
        item.scheduleCode.toLowerCase().includes(term) ||
        item.description?.toLowerCase().includes(term)
    );
  }, [data?.items, searchTerm]);

  // Handlers
  const handleOpenCreate = () => {
    setFormData(defaultFormData);
    setEditingId(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (schedule: MaintenanceSchedule) => {
    setFormData({
      name: schedule.name,
      description: schedule.description || '',
      category: schedule.category,
      recurrenceType: schedule.recurrenceRule.type,
      recurrenceInterval: schedule.recurrenceRule.interval || 1,
      startDate: schedule.startDate?.split('T')[0] || '',
      endDate: schedule.endDate?.split('T')[0] || '',
      estimatedDurationMinutes: schedule.estimatedDurationMinutes || 60,
      estimatedCost: schedule.estimatedCost || 0,
      currency: schedule.currency || 'TRY',
      instructions: schedule.instructions || '',
      autoGenerateWorkOrder: schedule.autoGenerateWorkOrder,
      generateDaysBefore: schedule.generateDaysBefore || 7,
      notes: schedule.notes || '',
    });
    setEditingId(schedule.id);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          name: formData.name,
          description: formData.description || undefined,
          category: formData.category,
          recurrenceRule: {
            type: formData.recurrenceType,
            interval: formData.recurrenceInterval,
          },
          startDate: formData.startDate || undefined,
          endDate: formData.endDate || undefined,
          estimatedDurationMinutes: formData.estimatedDurationMinutes,
          estimatedCost: formData.estimatedCost || undefined,
          currency: formData.currency,
          instructions: formData.instructions || undefined,
          autoGenerateWorkOrder: formData.autoGenerateWorkOrder,
          generateDaysBefore: formData.generateDaysBefore,
          notes: formData.notes || undefined,
        });
      } else {
        const input: CreateMaintenanceScheduleInput = {
          name: formData.name,
          description: formData.description || undefined,
          category: formData.category,
          recurrenceRule: {
            type: formData.recurrenceType,
            interval: formData.recurrenceInterval,
          },
          startDate: formData.startDate,
          endDate: formData.endDate || undefined,
          estimatedDurationMinutes: formData.estimatedDurationMinutes,
          estimatedCost: formData.estimatedCost || undefined,
          currency: formData.currency,
          instructions: formData.instructions || undefined,
          autoGenerateWorkOrder: formData.autoGenerateWorkOrder,
          generateDaysBefore: formData.generateDaysBefore,
          notes: formData.notes || undefined,
        };
        await createMutation.mutateAsync(input);
      }
      setIsModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error saving maintenance schedule:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Bu bakım planını silmek istediğinizden emin misiniz?')) {
      try {
        await deleteMutation.mutateAsync(id);
        refetch();
      } catch (err) {
        console.error('Error deleting maintenance schedule:', err);
      }
    }
  };

  const handlePause = async (id: string) => {
    try {
      await pauseMutation.mutateAsync(id);
      refetch();
    } catch (err) {
      console.error('Error pausing maintenance schedule:', err);
    }
  };

  const handleResume = async (id: string) => {
    try {
      await resumeMutation.mutateAsync(id);
      refetch();
    } catch (err) {
      console.error('Error resuming maintenance schedule:', err);
    }
  };

  const handleFilterChange = (key: keyof MaintenanceScheduleFilter, value: string) => {
    if (value === '') {
      const newFilter = { ...filter };
      delete newFilter[key];
      setFilter(newFilter);
    } else if (key === 'status') {
      setFilter({ ...filter, status: [value as MaintenanceScheduleStatus] });
    } else if (key === 'category') {
      setFilter({ ...filter, category: [value as MaintenanceCategory] });
    }
    setPage(1);
  };

  // Format date
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('tr-TR');
  };

  // Check if overdue
  const isOverdue = (nextDueDate?: string) => {
    if (!nextDueDate) return false;
    return new Date(nextDueDate) < new Date();
  };

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached data keeps rendering the list
  // and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="p-6">
        <Alert type="error">Bakım planları yüklenirken bir hata oluştu.</Alert>
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
          Bakım planları yenilenemedi — son yüklenen veriler gösteriliyor.
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bakım Planları</h1>
          <p className="text-sm text-gray-500 mt-1">
            Önleyici bakım planlarını görüntüleyin ve yönetin
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ProcessAutoGenerateButton />
          <Button onClick={handleOpenCreate}>Yeni Bakım Planı</Button>
        </div>
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
            value={filter.category?.[0] || ''}
            onChange={(e) => handleFilterChange('category', e.target.value)}
            options={[
              { value: '', label: 'Tüm Kategoriler' },
              ...Object.entries(categoryLabels).map(([value, label]) => ({
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
                    Kod / İsim
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Kategori
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tekrar
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Durum
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sonraki Tarih
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Çalıştırma
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    İşlemler
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      Henüz bakım planı bulunmuyor
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {item.scheduleCode}
                        </div>
                        <div className="text-sm text-gray-500">{item.name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {categoryLabels[item.category]}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {recurrenceLabels[item.recurrenceRule.type]}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge className={statusColors[item.status]}>
                          {statusLabels[item.status]}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`text-sm ${
                            isOverdue(item.nextDueDate) ? 'text-red-600 font-medium' : 'text-gray-500'
                          }`}
                        >
                          {formatDate(item.nextDueDate)}
                          {isOverdue(item.nextDueDate) && ' (Gecikmiş)'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.executionCount} kez
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenEdit(item)}
                            className="text-indigo-600 hover:text-indigo-900"
                          >
                            Düzenle
                          </button>
                          {item.status === 'ACTIVE' && (
                            <button
                              onClick={() => handlePause(item.id)}
                              className="text-yellow-600 hover:text-yellow-900"
                            >
                              Duraklat
                            </button>
                          )}
                          {item.status === 'PAUSED' && (
                            <button
                              onClick={() => handleResume(item.id)}
                              className="text-green-600 hover:text-green-900"
                            >
                              Devam Et
                            </button>
                          )}
                          <GenerateWorkOrderButton schedule={item} />
                          <UpdateMeterReadingButton schedule={item} />
                          {canCompleteMaintenance && item.status === 'ACTIVE' && (
                            <button
                              onClick={() => setCompletingSchedule(item)}
                              className="text-emerald-700 hover:text-emerald-900"
                              title="Bu plan döngüsünü kapat (sayaç + notlar)"
                            >
                              Bakımı Kapat
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="text-red-600 hover:text-red-900"
                          >
                            Sil
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
        title={editingId ? 'Bakım Planı Düzenle' : 'Yeni Bakım Planı'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Plan Adı"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
          <Input
            label="Açıklama"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Kategori"
              value={formData.category}
              onChange={(e) =>
                setFormData({ ...formData, category: e.target.value as MaintenanceCategory })
              }
              options={Object.entries(categoryLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Select
              label="Tekrar Tipi"
              value={formData.recurrenceType}
              onChange={(e) =>
                setFormData({ ...formData, recurrenceType: e.target.value as RecurrenceType })
              }
              options={Object.entries(recurrenceLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Başlangıç Tarihi"
              type="date"
              value={formData.startDate}
              onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
              required
            />
            <Input
              label="Bitiş Tarihi"
              type="date"
              value={formData.endDate}
              onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
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
            <Input
              label="Tahmini Maliyet"
              type="number"
              value={formData.estimatedCost}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  estimatedCost: parseFloat(e.target.value) || 0,
                })
              }
            />
          </div>
          <Input
            label="Talimatlar"
            value={formData.instructions}
            onChange={(e) => setFormData({ ...formData, instructions: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="autoGenerate"
                checked={formData.autoGenerateWorkOrder}
                onChange={(e) =>
                  setFormData({ ...formData, autoGenerateWorkOrder: e.target.checked })
                }
                className="mr-2"
              />
              <label htmlFor="autoGenerate" className="text-sm text-gray-700">
                Otomatik İş Emri Oluştur
              </label>
            </div>
            <Input
              label="Kaç Gün Önce"
              type="number"
              value={formData.generateDaysBefore}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  generateDaysBefore: parseInt(e.target.value) || 0,
                })
              }
              disabled={!formData.autoGenerateWorkOrder}
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

      {completingSchedule && (
        <CompleteMaintenanceModal
          isOpen={!!completingSchedule}
          onClose={() => setCompletingSchedule(null)}
          schedule={completingSchedule}
          onSuccess={() => refetch()}
        />
      )}
    </div>
  );
};

export default MaintenanceSchedulesPage;
