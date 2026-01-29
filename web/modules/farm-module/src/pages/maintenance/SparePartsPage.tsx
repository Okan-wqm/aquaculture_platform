/**
 * Spare Parts Page
 * Displays and manages spare parts inventory
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
  useSpareParts,
  useStockSummary,
  SparePart,
  SparePartStatus,
  SparePartFilter,
} from '../../hooks/useMaintenance';

// Status colors
const statusColors: Record<SparePartStatus, string> = {
  IN_STOCK: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  ON_ORDER: 'bg-blue-100 text-blue-800',
  DISCONTINUED: 'bg-gray-100 text-gray-800',
};

// Status labels
const statusLabels: Record<SparePartStatus, string> = {
  IN_STOCK: 'Stokta',
  LOW_STOCK: 'Az Stok',
  OUT_OF_STOCK: 'Stok Yok',
  ON_ORDER: 'Siparişte',
  DISCONTINUED: 'Üretilmiyor',
};

export const SparePartsPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<SparePartFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // API hooks
  const { data, isLoading, error, refetch } = useSpareParts(filter, page, 20);
  const { data: stockSummary } = useStockSummary();

  // Filtered data
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    if (!searchTerm) return data.items;
    const term = searchTerm.toLowerCase();
    return data.items.filter(
      (item) =>
        item.name.toLowerCase().includes(term) ||
        item.code.toLowerCase().includes(term) ||
        item.partNumber.toLowerCase().includes(term) ||
        item.description?.toLowerCase().includes(term)
    );
  }, [data?.items, searchTerm]);

  const handleFilterChange = (key: keyof SparePartFilter, value: string) => {
    if (value === '') {
      const newFilter = { ...filter };
      delete newFilter[key];
      setFilter(newFilter);
    } else if (key === 'status') {
      setFilter({ ...filter, status: [value as SparePartStatus] });
    }
    setPage(1);
  };

  // Format currency
  const formatCurrency = (value?: number, currency = 'TRY') => {
    if (value === undefined) return '-';
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
    }).format(value);
  };

  if (error) {
    return (
      <div className="p-6">
        <Alert type="error">Yedek parçalar yüklenirken bir hata oluştu.</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Yedek Parçalar</h1>
          <p className="text-sm text-gray-500 mt-1">
            Yedek parça envanterini görüntüleyin ve yönetin
          </p>
        </div>
        <Button onClick={() => refetch()}>Yenile</Button>
      </div>

      {/* Summary Cards */}
      {stockSummary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-sm text-gray-500">Toplam Parça</div>
            <div className="text-2xl font-bold text-gray-900">{stockSummary.totalParts}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500">Stokta</div>
            <div className="text-2xl font-bold text-green-600">{stockSummary.inStockCount}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500">Az Stok</div>
            <div className="text-2xl font-bold text-yellow-600">{stockSummary.lowStockCount}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500">Stok Yok</div>
            <div className="text-2xl font-bold text-red-600">{stockSummary.outOfStockCount}</div>
          </Card>
        </div>
      )}

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
                    Parça No
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Durum
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Miktar
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Min / Max
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Birim Fiyat
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                      Henüz yedek parça bulunmuyor
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {item.code}
                        </div>
                        <div className="text-sm text-gray-500">{item.name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.partNumber}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge className={statusColors[item.status]}>
                          {statusLabels[item.status]}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`text-sm font-medium ${
                            item.quantity <= item.minStock
                              ? 'text-red-600'
                              : item.quantity <= item.reorderPoint
                              ? 'text-yellow-600'
                              : 'text-gray-900'
                          }`}
                        >
                          {item.quantity} {item.unit}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.minStock} / {item.maxStock}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatCurrency(item.unitPrice, item.currency)}
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

export default SparePartsPage;
