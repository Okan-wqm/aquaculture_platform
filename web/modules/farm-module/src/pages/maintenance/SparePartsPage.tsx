/**
 * Spare Parts Page
 * Displays and manages spare parts inventory with full CRUD operations.
 *
 * Stock lives in the ONE storage ledger (FARM-HIGH-338): the listed quantity,
 * on-order quantity and status are ledger-derived and read-only here. The
 * catalogue form picks a real storage location; stock changes only through the
 * "Açılış stoğu" of a new part or a movement (SparePartStockMovementModal).
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
  formatErrorForToast,
  parseMoney,
  DEFAULT_CURRENCY,
  useConfirm,
  useToast,
  PageHeader,
  type SelectOption,
} from '@aquaculture/shared-ui';
import {
  useSpareParts,
  useCreateSparePart,
  useUpdateSparePart,
  useDeleteSparePart,
  useStockSummary,
  SparePart,
  SparePartBinDetail,
  SparePartStatus,
  SparePartFilter,
  CreateSparePartInput,
  UpdateSparePartInput,
} from '../../hooks/useMaintenance';
import { useStorageLocationList } from '../../hooks/useStorageLocations';
import { isBlockingError } from '../../utils/list-view-state';
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import {
  SparePartStockMovementModal,
  buildStorageLocationOptions,
} from './components/SparePartStockMovementModal';

// Status colors
const statusColors: Record<SparePartStatus, string> = {
  IN_STOCK: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  LOW_STOCK: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  OUT_OF_STOCK: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  ON_ORDER: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  DISCONTINUED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
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
  name: string;
  partNumber: string;
  description: string;
  manufacturer: string;
  /** Create only: booked as ONE ledger IN movement at `storageLocationId`. */
  openingQuantity: number;
  /** '' = no location chosen. */
  storageLocationId: string;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  unit: string;
  unitPrice: number;
  currency: string;
  leadTimeDays: number;
  /** Bin detail: free text INSIDE the storage location, not a location itself. */
  binWarehouse: string;
  binShelf: string;
  binBox: string;
  /** Not edited on this form; carried through so a save never wipes it. */
  binNotes: string;
  notes: string;
}

const defaultFormData: SparePartFormData = {
  name: '',
  partNumber: '',
  description: '',
  manufacturer: '',
  openingQuantity: 0,
  storageLocationId: '',
  minStock: 5,
  maxStock: 100,
  reorderPoint: 10,
  unit: 'adet',
  unitPrice: 0,
  currency: 'TRY',
  leadTimeDays: 7,
  binWarehouse: '',
  binShelf: '',
  binBox: '',
  binNotes: '',
  notes: '',
};

const OPENING_STOCK_NEEDS_LOCATION = 'Açılış stoğu için depolama lokasyonu seçin.';

export const SparePartsPage: React.FC = () => {
  // Filter state
  const [filter, setFilter] = useState<SparePartFilter>({});
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');

  // Modal state — `editingPart` null = creating
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState<SparePartFormData>(defaultFormData);
  const [editingPart, setEditingPart] = useState<SparePart | null>(null);
  const [locationError, setLocationError] = useState<string | undefined>(undefined);

  // Stock movement modal — mounted only while a part is selected
  const [selectedPartForStock, setSelectedPartForStock] = useState<SparePart | null>(null);

  // API hooks
  const { data, isLoading, error, refetch } = useSpareParts(filter, page, 20);
  const { data: stockSummary } = useStockSummary();
  const { data: locationsData } = useStorageLocationList();
  const createMutation = useCreateSparePart();
  const updateMutation = useUpdateSparePart();
  const deleteMutation = useDeleteSparePart();
  const { toast } = useToast();

  const locations = locationsData?.items ?? [];
  // A part that already has a home location can be re-homed but not un-homed
  // (the backend has no "clear"), so the empty entry is offered only without one.
  const formLocationOptions: SelectOption[] = [
    ...(editingPart?.storageLocationId ? [] : [{ value: '', label: 'Lokasyon seçilmedi' }]),
    ...buildStorageLocationOptions(locations, editingPart?.storageLocationId),
  ];

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
        item.description?.toLowerCase().includes(term),
    );
  }, [data?.items, searchTerm]);

  // Handlers
  const handleOpenCreate = () => {
    setFormData(defaultFormData);
    setEditingPart(null);
    setLocationError(undefined);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (part: SparePart) => {
    setFormData({
      name: part.name,
      partNumber: part.partNumber,
      description: part.description || '',
      manufacturer: part.manufacturer || '',
      openingQuantity: 0,
      storageLocationId: part.storageLocationId ?? '',
      minStock: part.minStock,
      maxStock: part.maxStock,
      reorderPoint: part.reorderPoint,
      unit: part.unit,
      unitPrice: part.unitPrice || 0,
      currency: part.currency || 'TRY',
      leadTimeDays: part.leadTimeDays || 7,
      binWarehouse: part.binDetail?.warehouse ?? '',
      binShelf: part.binDetail?.shelf ?? '',
      binBox: part.binDetail?.bin ?? '',
      binNotes: part.binDetail?.notes ?? '',
      notes: part.notes || '',
    });
    setEditingPart(part);
    setLocationError(undefined);
    setIsModalOpen(true);
  };

  /**
   * Catalogue-only payloads: `code` is server-generated and `quantity`/`status`
   * are ledger-derived, so neither input type can carry them (compile error).
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const binDetail: SparePartBinDetail = {
      warehouse: formData.binWarehouse || undefined,
      shelf: formData.binShelf || undefined,
      bin: formData.binBox || undefined,
      notes: formData.binNotes || undefined,
    };
    const hasBinDetail = Object.values(binDetail).some(Boolean);
    const catalogue = {
      name: formData.name,
      partNumber: formData.partNumber,
      description: formData.description || undefined,
      manufacturer: formData.manufacturer || undefined,
      minStock: formData.minStock,
      maxStock: formData.maxStock,
      reorderPoint: formData.reorderPoint,
      unit: formData.unit,
      unitPrice: formData.unitPrice || undefined,
      currency: formData.currency,
      leadTimeDays: formData.leadTimeDays || undefined,
      notes: formData.notes || undefined,
    };

    if (!editingPart && formData.openingQuantity > 0 && !formData.storageLocationId) {
      setLocationError(OPENING_STOCK_NEEDS_LOCATION);
      return;
    }

    try {
      if (editingPart) {
        const input: UpdateSparePartInput = {
          id: editingPart.id,
          ...catalogue,
          // Re-home only on a real change; stock already booked stays where it is.
          storageLocationId:
            formData.storageLocationId &&
            formData.storageLocationId !== editingPart.storageLocationId
              ? formData.storageLocationId
              : undefined,
          // The form holds the whole blob, so an emptied form clears a stored one.
          binDetail: hasBinDetail || editingPart.binDetail ? binDetail : undefined,
        };
        await updateMutation.mutateAsync(input);
      } else {
        const withBin = { ...catalogue, binDetail: hasBinDetail ? binDetail : undefined };
        // The guard above leaves a positive opening quantity only WITH a location.
        const input: CreateSparePartInput = formData.storageLocationId
          ? {
              ...withBin,
              openingQuantity: formData.openingQuantity,
              storageLocationId: formData.storageLocationId,
            }
          : { ...withBin, openingQuantity: 0 };
        await createMutation.mutateAsync(input);
      }
      setIsModalOpen(false);
    } catch (err) {
      toast({
        title: 'Yedek parça kaydedilemedi',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  const confirm = useConfirm();
  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Yedek parçayı sil?',
        confirmText: 'Sil',
        cancelText: 'Vazgeç',
        variant: 'danger',
      })
    ) {
      try {
        await deleteMutation.mutateAsync(id);
      } catch (err) {
        toast({
          title: 'Yedek parça silinemedi',
          description: formatErrorForToast(err),
          variant: 'error',
        });
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

  type ItemRow = (typeof filteredItems)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'kodSim',
      header: 'Kod / İsim',
      render: (_value, item) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.code}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{item.name}</div>
        </>
      ),
    },
    {
      key: 'parANo',
      header: 'Parça No',
      render: (_value, item) => item.partNumber,
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, item) => (
        <Badge className={statusColors[item.status]}>{statusLabels[item.status]}</Badge>
      ),
    },
    {
      key: 'miktar',
      header: 'Miktar',
      render: (_value, item) => (
        <>
          <span
            className={`text-sm font-medium ${
              item.quantity <= item.minStock
                ? 'text-error-600 dark:text-error-400'
                : item.quantity <= item.reorderPoint
                  ? 'text-warning-600 dark:text-warning-400'
                  : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {item.quantity} {item.unit}
          </span>
          {item.onOrderQuantity > 0 && (
            <div className="text-xs text-info-600 dark:text-info-400">
              +{item.onOrderQuantity} {item.unit} siparişte
            </div>
          )}
        </>
      ),
    },
    {
      key: 'minMax',
      header: 'Min / Max',
      render: (_value, item) => (
        <>
          {item.minStock} / {item.maxStock}
        </>
      ),
    },
    {
      key: 'birimFiyat',
      header: 'Birim Fiyat',
      render: (_value, item) => formatCurrency(parseMoney(item.unitPriceDecimal), item.currency),
    },
    {
      key: 'lemler',
      header: 'İşlemler',
      align: 'right',
      render: (_value, item) => (
        <>
          <Button variant="ghost" className="mr-3" onClick={() => setSelectedPartForStock(item)}>
            Stok
          </Button>
          <Button variant="ghost" className="mr-3" onClick={() => handleOpenEdit(item)}>
            Düzenle
          </Button>
          <Button variant="ghost" onClick={() => handleDelete(item.id)}>
            Sil
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded data visible. */}
      {error && (
        <Alert type="warning" action={{ label: 'Yeniden Dene', onClick: () => refetch() }}>
          Yedek parçalar yenilenemedi — son yüklenen veriler gösteriliyor.
        </Alert>
      )}

      {/* Header */}
      <PageHeader
        title="Yedek Parçalar"
        description="Yedek parça envanterini görüntüleyin ve yönetin"
        actions={<Button onClick={handleOpenCreate}>Yeni Yedek Parça</Button>}
      />

      {/* Summary Cards */}
      {stockSummary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Toplam Parça</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {stockSummary.totalParts}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Stokta</div>
            <div className="text-2xl font-bold text-success-600 dark:text-success-400">
              {stockSummary.inStockCount}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Az Stok</div>
            <div className="text-2xl font-bold text-warning-600 dark:text-warning-400">
              {stockSummary.lowStockCount}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Stok Yok</div>
            <div className="text-2xl font-bold text-error-600 dark:text-error-400">
              {stockSummary.outOfStockCount}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">Toplam Değer</div>
            <div className="text-2xl font-bold text-info-600 dark:text-info-400">
              {formatCurrency(parseMoney(stockSummary.totalValueDecimal))}
            </div>
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
          <DataTable<ItemRow>
            data={filteredItems}
            columns={itemRowColumns}
            keyExtractor={(item) => item.id}
            emptyMessage="Henüz yedek parça bulunmuyor"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
        )}

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div className="text-sm text-gray-500 dark:text-gray-400">
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
        title={editingPart ? `Yedek Parça Düzenle (${editingPart.code})` : 'Yeni Yedek Parça'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Parça Numarası"
              value={formData.partNumber}
              onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
              required
            />
            <Input
              label="Parça Adı"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
          </div>
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
          <Select
            label="Depolama Lokasyonu"
            value={formData.storageLocationId}
            onChange={(e) => {
              setFormData({ ...formData, storageLocationId: e.target.value });
              setLocationError(undefined);
            }}
            options={formLocationOptions}
            required={!editingPart && formData.openingQuantity > 0}
            error={locationError}
            helperText={
              editingPart
                ? 'Değişiklik yalnızca sonraki hareketlerin varsayılan lokasyonunu değiştirir; mevcut stok taşınmaz.'
                : undefined
            }
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {!editingPart && (
              <Input
                label="Açılış stoğu"
                type="number"
                min={0}
                step={1}
                value={formData.openingQuantity}
                onChange={(e) => {
                  setFormData({
                    ...formData,
                    openingQuantity: Math.max(0, parseInt(e.target.value, 10) || 0),
                  });
                  setLocationError(undefined);
                }}
              />
            )}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
          {/* Bin detail: free text for where the part sits INSIDE the location. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Input
              label="Depo Bölümü"
              value={formData.binWarehouse}
              onChange={(e) => setFormData({ ...formData, binWarehouse: e.target.value })}
            />
            <Input
              label="Raf"
              value={formData.binShelf}
              onChange={(e) => setFormData({ ...formData, binShelf: e.target.value })}
            />
            <Input
              label="Kutu"
              value={formData.binBox}
              onChange={(e) => setFormData({ ...formData, binBox: e.target.value })}
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
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
              {createMutation.isPending || updateMutation.isPending ? 'Kaydediliyor...' : 'Kaydet'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Stock Movement Modal */}
      {selectedPartForStock && (
        <SparePartStockMovementModal
          part={selectedPartForStock}
          locations={locations}
          onClose={() => setSelectedPartForStock(null)}
        />
      )}
    </div>
  );
};

export default SparePartsPage;
