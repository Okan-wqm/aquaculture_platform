/**
 * Spare Parts Page
 * Displays and manages spare parts inventory with full CRUD operations
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
  formatCurrency as sharedFormatCurrency,
  DEFAULT_CURRENCY,
} from '@aquaculture/shared-ui';
import {
  useSpareParts,
  useCreateSparePart,
  useUpdateSparePart,
  useDeleteSparePart,
  useStockSummary,
  useRecordStockMovement,
  SparePart,
  SparePartStatus,
  SparePartFilter,
  CreateSparePartInput,
} from '../../hooks/useMaintenance';
import { isBlockingError } from '../../utils/list-view-state';

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

interface SparePartFormData {
  code: string;
  name: string;
  partNumber: string;
  description: string;
  manufacturer: string;
  quantity: number;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  unit: string;
  unitPrice: number;
  currency: string;
  leadTimeDays: number;
  warehouseLocation: string;
  shelfLocation: string;
  binLocation: string;
  notes: string;
}

const defaultFormData: SparePartFormData = {
  code: '',
  name: '',
  partNumber: '',
  description: '',
  manufacturer: '',
  quantity: 0,
  minStock: 5,
  maxStock: 100,
  reorderPoint: 10,
  unit: 'adet',
  unitPrice: 0,
  currency: 'TRY',
  leadTimeDays: 7,
  warehouseLocation: '',
  shelfLocation: '',
  binLocation: '',
  notes: '',
};

interface StockMovementFormData {
  quantity: number;
  movementType: 'in' | 'out' | 'adjustment';
  reason: string;
  notes: string;
}

const defaultStockMovementData: StockMovementFormData = {
  quantity: 0,
  movementType: 'in',
  reason: '',
  notes: '',
};

export const SparePartsPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<SparePartFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<SparePartFormData>(defaultFormData);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Stock movement modal
  const [isStockModalOpen, setIsStockModalOpen] = useState(false);
  const [stockMovementData, setStockMovementData] = useState<StockMovementFormData>(defaultStockMovementData);
  const [selectedPartForStock, setSelectedPartForStock] = useState<SparePart | null>(null);

  // API hooks
  const { data, isLoading, error, refetch } = useSpareParts(filter, page, 20);
  const { data: stockSummary } = useStockSummary();
  const createMutation = useCreateSparePart();
  const updateMutation = useUpdateSparePart();
  const deleteMutation = useDeleteSparePart();
  const stockMovementMutation = useRecordStockMovement();

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

  // Handlers
  const handleOpenCreate = () => {
    setFormData(defaultFormData);
    setEditingId(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (part: SparePart) => {
    setFormData({
      code: part.code,
      name: part.name,
      partNumber: part.partNumber,
      description: part.description || '',
      manufacturer: part.manufacturer || '',
      quantity: part.quantity,
      minStock: part.minStock,
      maxStock: part.maxStock,
      reorderPoint: part.reorderPoint,
      unit: part.unit,
      unitPrice: part.unitPrice || 0,
      currency: part.currency || 'TRY',
      leadTimeDays: part.leadTimeDays || 7,
      warehouseLocation: part.location?.warehouse || '',
      shelfLocation: part.location?.shelf || '',
      binLocation: part.location?.bin || '',
      notes: part.notes || '',
    });
    setEditingId(part.id);
    setIsModalOpen(true);
  };

  const handleOpenStockMovement = (part: SparePart) => {
    setSelectedPartForStock(part);
    setStockMovementData(defaultStockMovementData);
    setIsStockModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const location = {
        warehouse: formData.warehouseLocation || undefined,
        shelf: formData.shelfLocation || undefined,
        bin: formData.binLocation || undefined,
      };

      if (editingId) {
        await updateMutation.mutateAsync({
          id: editingId,
          code: formData.code,
          name: formData.name,
          partNumber: formData.partNumber,
          description: formData.description || undefined,
          manufacturer: formData.manufacturer || undefined,
          quantity: formData.quantity,
          minStock: formData.minStock,
          maxStock: formData.maxStock,
          reorderPoint: formData.reorderPoint,
          unit: formData.unit,
          unitPrice: formData.unitPrice || undefined,
          currency: formData.currency,
          leadTimeDays: formData.leadTimeDays || undefined,
          location: Object.values(location).some(v => v) ? location : undefined,
          notes: formData.notes || undefined,
        });
      } else {
        const input: CreateSparePartInput = {
          code: formData.code,
          name: formData.name,
          partNumber: formData.partNumber,
          description: formData.description || undefined,
          manufacturer: formData.manufacturer || undefined,
          quantity: formData.quantity,
          minStock: formData.minStock,
          maxStock: formData.maxStock,
          reorderPoint: formData.reorderPoint,
          unit: formData.unit,
          unitPrice: formData.unitPrice || undefined,
          currency: formData.currency,
          leadTimeDays: formData.leadTimeDays || undefined,
          location: Object.values(location).some(v => v) ? location : undefined,
          notes: formData.notes || undefined,
        };
        await createMutation.mutateAsync(input);
      }
      setIsModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error saving spare part:', err);
    }
  };

  const handleStockMovementSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPartForStock) return;

    try {
      await stockMovementMutation.mutateAsync({
        sparePartId: selectedPartForStock.id,
        quantity: stockMovementData.quantity,
        movementType: stockMovementData.movementType,
        reason: stockMovementData.reason || undefined,
        notes: stockMovementData.notes || undefined,
      });
      setIsStockModalOpen(false);
      refetch();
    } catch (err) {
      console.error('Error recording stock movement:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Bu yedek parçayı silmek istediğinizden emin misiniz?')) {
      try {
        await deleteMutation.mutateAsync(id);
        refetch();
      } catch (err) {
        console.error('Error deleting spare part:', err);
      }
    }
  };

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

  // Format currency — delegates to shared utility
  const formatCurrency = (value?: number, currency = DEFAULT_CURRENCY) => {
    if (value === undefined) return '-';
    return sharedFormatCurrency(value, currency);
  };

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached data keeps rendering the list
  // and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (data?.items?.length ?? 0) > 0)) {
    return (
      <div className="p-6">
        <Alert type="error">Yedek parçalar yüklenirken bir hata oluştu.</Alert>
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
          Yedek parçalar yenilenemedi — son yüklenen veriler gösteriliyor.
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Yedek Parçalar</h1>
          <p className="text-sm text-gray-500 mt-1">
            Yedek parça envanterini görüntüleyin ve yönetin
          </p>
        </div>
        <Button onClick={handleOpenCreate}>Yeni Yedek Parça</Button>
      </div>

      {/* Summary Cards */}
      {stockSummary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
          <Card className="p-4">
            <div className="text-sm text-gray-500">Toplam Değer</div>
            <div className="text-2xl font-bold text-blue-600">{formatCurrency(stockSummary.totalValue)}</div>
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
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    İşlemler
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
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
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleOpenStockMovement(item)}
                          className="text-green-600 hover:text-green-900 mr-3"
                        >
                          Stok
                        </button>
                        <button
                          onClick={() => handleOpenEdit(item)}
                          className="text-indigo-600 hover:text-indigo-900 mr-3"
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
        title={editingId ? 'Yedek Parça Düzenle' : 'Yeni Yedek Parça'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Parça Kodu"
              value={formData.code}
              onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              required
            />
            <Input
              label="Parça Numarası"
              value={formData.partNumber}
              onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
              required
            />
          </div>
          <Input
            label="Parça Adı"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
          <Input
            label="Açıklama"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
          <Input
            label="Üretici"
            value={formData.manufacturer}
            onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
          />
          <div className="grid grid-cols-4 gap-4">
            <Input
              label="Miktar"
              type="number"
              value={formData.quantity}
              onChange={(e) =>
                setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })
              }
              required
            />
            <Input
              label="Min Stok"
              type="number"
              value={formData.minStock}
              onChange={(e) =>
                setFormData({ ...formData, minStock: parseInt(e.target.value) || 0 })
              }
              required
            />
            <Input
              label="Max Stok"
              type="number"
              value={formData.maxStock}
              onChange={(e) =>
                setFormData({ ...formData, maxStock: parseInt(e.target.value) || 0 })
              }
              required
            />
            <Input
              label="Sipariş Noktası"
              type="number"
              value={formData.reorderPoint}
              onChange={(e) =>
                setFormData({ ...formData, reorderPoint: parseInt(e.target.value) || 0 })
              }
              required
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Input
              label="Birim"
              value={formData.unit}
              onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
              required
            />
            <Input
              label="Birim Fiyat"
              type="number"
              step="0.01"
              value={formData.unitPrice}
              onChange={(e) =>
                setFormData({ ...formData, unitPrice: parseFloat(e.target.value) || 0 })
              }
            />
            <Select
              label="Para Birimi"
              value={formData.currency}
              onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
              options={[
                { value: 'TRY', label: 'TRY' },
                { value: 'USD', label: 'USD' },
                { value: 'EUR', label: 'EUR' },
              ]}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Input
              label="Depo"
              value={formData.warehouseLocation}
              onChange={(e) => setFormData({ ...formData, warehouseLocation: e.target.value })}
            />
            <Input
              label="Raf"
              value={formData.shelfLocation}
              onChange={(e) => setFormData({ ...formData, shelfLocation: e.target.value })}
            />
            <Input
              label="Kutu"
              value={formData.binLocation}
              onChange={(e) => setFormData({ ...formData, binLocation: e.target.value })}
            />
          </div>
          <Input
            label="Tedarik Süresi (gün)"
            type="number"
            value={formData.leadTimeDays}
            onChange={(e) =>
              setFormData({ ...formData, leadTimeDays: parseInt(e.target.value) || 0 })
            }
          />
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

      {/* Stock Movement Modal */}
      <Modal
        isOpen={isStockModalOpen}
        onClose={() => setIsStockModalOpen(false)}
        title={`Stok Hareketi - ${selectedPartForStock?.name || ''}`}
      >
        <form onSubmit={handleStockMovementSubmit} className="space-y-4">
          {selectedPartForStock && (
            <div className="bg-gray-50 p-4 rounded-lg mb-4">
              <div className="text-sm text-gray-500">Mevcut Stok</div>
              <div className="text-2xl font-bold text-gray-900">
                {selectedPartForStock.quantity} {selectedPartForStock.unit}
              </div>
            </div>
          )}
          <Select
            label="Hareket Tipi"
            value={stockMovementData.movementType}
            onChange={(e) =>
              setStockMovementData({
                ...stockMovementData,
                movementType: e.target.value as 'in' | 'out' | 'adjustment',
              })
            }
            options={[
              { value: 'in', label: 'Stok Girişi' },
              { value: 'out', label: 'Stok Çıkışı' },
              { value: 'adjustment', label: 'Düzeltme' },
            ]}
          />
          <Input
            label="Miktar"
            type="number"
            value={stockMovementData.quantity}
            onChange={(e) =>
              setStockMovementData({
                ...stockMovementData,
                quantity: parseInt(e.target.value) || 0,
              })
            }
            required
            min="1"
          />
          <Input
            label="Sebep"
            value={stockMovementData.reason}
            onChange={(e) =>
              setStockMovementData({ ...stockMovementData, reason: e.target.value })
            }
          />
          <Input
            label="Notlar"
            value={stockMovementData.notes}
            onChange={(e) =>
              setStockMovementData({ ...stockMovementData, notes: e.target.value })
            }
          />
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setIsStockModalOpen(false)}>
              İptal
            </Button>
            <Button type="submit" disabled={stockMovementMutation.isPending}>
              {stockMovementMutation.isPending ? 'Kaydediliyor...' : 'Kaydet'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default SparePartsPage;
