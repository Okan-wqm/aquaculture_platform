/**
 * Maintenance Schedules Page
 * Displays and manages preventive maintenance schedules
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
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
  MaintenanceCategory,
  RecurrenceType,
  MaintenanceScheduleFilter,
} from '../../hooks/useMaintenance';

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

export const MaintenanceSchedulesPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<MaintenanceScheduleFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // API hooks
  const { data, isLoading, error, refetch } = useMaintenanceSchedules(filter, page, 20);

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

  if (error) {
    return (
      <div className="p-6">
        <Alert type="error">Bakım planları yüklenirken bir hata oluştu.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bakım Planları</h1>
          <p className="text-sm text-gray-500 mt-1">
            Önleyici bakım planlarını görüntüleyin ve yönetin
          </p>
        </div>
        <Button onClick={() => refetch()}>Yenile</Button>
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
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
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
    </div>
  );
};

export default MaintenanceSchedulesPage;
