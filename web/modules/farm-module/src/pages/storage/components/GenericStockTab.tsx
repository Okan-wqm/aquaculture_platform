/**
 * Generic Stock Tab
 *
 * A single, configurable component that replaces the previously duplicated
 * FeedStockTab / ChemicalsStockTab / ConsumablesStockTab / HealthcareStockTab
 * implementations. Each concrete tab becomes a thin wrapper that passes the
 * appropriate `itemType`, `itemLabel`, and `columns` props.
 *
 * Features:
 *  - Filterable search across item name and lot number
 *  - "Add Stock" button that opens RecordStockMovementModal pre-filled for the tab's item type
 *  - Configurable table columns (itemName, location, lotNumber, quantity, expiry, notes)
 *  - Per-row "Adjust" and "Write Off" quick actions
 *  - Expiry date highlighting (row background) and badges (EXPIRED / EXPIRING SOON)
 *  - Loading, error, and empty states
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  useStorageInventory,
  useStorageOverview,
  StorageItemType,
  MovementType,
  LowStockAlert,
} from '../../../hooks/useStorageInventory';
import { RecordStockMovementModal } from './RecordStockMovementModal';
import { getExpiryRowClass, isExpired, isExpiringSoon } from '../utils/expiry-utils';

// ─── Public types ────────────────────────────────────────────────────────────

/** Column identifiers supported by GenericStockTab. */
export type StockTabColumn = 'itemName' | 'location' | 'lotNumber' | 'quantity' | 'expiry' | 'notes';

export interface StockTabProps {
  /** Which item type to query — determines the data source and pre-fill for action modals. */
  itemType: StorageItemType;
  /** Label shown in search placeholder and empty state (e.g., "feeds", "chemicals"). */
  itemLabel: string;
  /** Column configuration — tabs have slightly different columns. */
  columns: StockTabColumn[];
}

// ─── Column metadata ─────────────────────────────────────────────────────────

/** Human-readable header labels per column key. */
const COLUMN_HEADERS: Record<StockTabColumn, string> = {
  itemName: 'Item',
  location: 'Location',
  lotNumber: 'Lot Number',
  quantity: 'Quantity',
  expiry: 'Expiry',
  notes: 'Notes',
};

// ─── Modal defaults shape ────────────────────────────────────────────────────

interface ModalDefaults {
  movementType?: MovementType;
  itemId?: string;
  itemName?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const GenericStockTab: React.FC<StockTabProps> = ({ itemType, itemLabel, columns }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [modalDefaults, setModalDefaults] = useState<ModalDefaults>({});

  const { data: inventory, isLoading, error, refetch } = useStorageInventory(undefined, itemType);

  // Low-stock signal: the SAME server-side threshold the Overview tab shows
  // (master quantity <= minStock, computed in get-storage-overview) — surfaced
  // HERE, on the rows the operator actually restocks from. Matched by itemId.
  const { data: overview } = useStorageOverview();
  const lowStockByItemId = useMemo(() => {
    const map = new Map<string, LowStockAlert>();
    for (const alert of overview?.lowStockAlerts ?? []) {
      map.set(alert.itemId, alert);
    }
    return map;
  }, [overview?.lowStockAlerts]);

  const items = inventory || [];
  const lowStockCount = items.filter(item => lowStockByItemId.has(item.itemId)).length;

  const filtered = items.filter(item => {
    const term = searchTerm.toLowerCase();
    return (
      (item.itemName || '').toLowerCase().includes(term) ||
      (item.lotNumber || '').toLowerCase().includes(term)
    );
  });

  const hasExpiryColumn = columns.includes('expiry');

  /** Open the stock movement modal with preset defaults. */
  const openModal = useCallback((defaults: ModalDefaults) => {
    setModalDefaults(defaults);
    setModalOpen(true);
  }, []);

  /** Close the modal, clear defaults, and refresh data. */
  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalDefaults({});
    refetch();
  }, [refetch]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Search + Add Stock header */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            placeholder={`Search ${itemLabel}...`}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <svg
            className="absolute left-3 top-2.5 w-5 h-5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* Low-stock banner: items at/below their minimum — restock these first. */}
        {lowStockCount > 0 && (
          <span className="inline-flex items-center self-center px-3 py-1 rounded-full text-sm font-medium bg-amber-100 text-amber-800 whitespace-nowrap">
            {lowStockCount} low stock
          </span>
        )}

        {/* Primary entry point for receiving new deliveries or recording manual
            stock additions. Pre-fills item type and movement type to IN. */}
        <button
          onClick={() => openModal({ movementType: MovementType.IN })}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium whitespace-nowrap"
        >
          + Add Stock
        </button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load {itemLabel} stock.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Data table */}
      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {columns.map(col => (
                  <th
                    key={col}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
                  >
                    {COLUMN_HEADERS[col]}
                  </th>
                ))}
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filtered.map(item => (
                <tr
                  key={item.id}
                  className={`hover:bg-gray-50 ${hasExpiryColumn ? getExpiryRowClass(item.expiryDate) : ''}`}
                >
                  {columns.map(col => (
                    <td key={col} className={getCellClassName(col)}>
                      {renderCell(col, item, lowStockByItemId.get(item.itemId))}
                    </td>
                  ))}

                  {/* Per-row actions: Adjust (count correction) and Write Off (waste disposal). */}
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() =>
                          openModal({
                            movementType: MovementType.ADJUSTMENT,
                            itemId: item.itemId,
                            itemName: item.itemName,
                          })
                        }
                        className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                      >
                        Adjust
                      </button>
                      <button
                        onClick={() =>
                          openModal({
                            movementType: MovementType.WASTE,
                            itemId: item.itemId,
                            itemName: item.itemName,
                          })
                        }
                        className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        Write Off
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Empty state */}
          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-500 text-sm">
              No {itemLabel} stock items found.
            </div>
          )}
        </div>
      )}

      {/* Stock movement modal — pre-filled with the tab's item type */}
      <RecordStockMovementModal
        isOpen={modalOpen}
        onClose={closeModal}
        defaultItemType={itemType}
        defaultMovementType={modalDefaults.movementType}
        defaultItemId={modalDefaults.itemId}
        defaultItemName={modalDefaults.itemName}
      />
    </div>
  );
};

// ─── Cell rendering helpers ──────────────────────────────────────────────────

/** Returns the Tailwind class for a cell based on column type. */
function getCellClassName(col: StockTabColumn): string {
  switch (col) {
    case 'itemName':
      return 'px-6 py-4 text-sm font-medium text-gray-900';
    case 'quantity':
      return 'px-6 py-4 text-sm font-medium text-gray-900';
    case 'lotNumber':
      return 'px-6 py-4 text-sm text-gray-500 font-mono';
    default:
      return 'px-6 py-4 text-sm text-gray-500';
  }
}

/**
 * Renders the content of a single table cell based on column type.
 * The `item` parameter uses the StorageInventoryItem shape from the hook.
 */
function renderCell(
  col: StockTabColumn,
  item: {
    itemName?: string;
    locationName?: string;
    lotNumber?: string;
    quantity: number;
    unit: string;
    expiryDate?: string;
    notes?: string;
  },
  lowStock?: LowStockAlert,
): React.ReactNode {
  switch (col) {
    case 'itemName':
      return (
        <>
          {item.itemName || '-'}
          {/* Low-stock badge — same server-side threshold as the Overview tab
              (master quantity <= minStock). Red = nothing left; amber = at or
              below the reorder point, restock soon. */}
          {lowStock && (
            <span
              className={`ml-2 text-xs px-1.5 py-0.5 rounded font-medium ${
                lowStock.currentQuantity === 0
                  ? 'bg-red-100 text-red-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
              title={`${lowStock.currentQuantity} / min ${lowStock.minStock} ${lowStock.unit}`}
            >
              {lowStock.currentQuantity === 0 ? 'OUT OF STOCK' : 'LOW STOCK'}
            </span>
          )}
        </>
      );

    case 'location':
      return item.locationName || '-';

    case 'lotNumber':
      return item.lotNumber || '-';

    case 'quantity':
      return `${item.quantity} ${item.unit}`;

    case 'expiry':
      return (
        <>
          {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString('nb-NO') : '-'}
          {/* Visual badge indicates urgency level for warehouse staff scanning
              the inventory list. Red = must be disposed/used immediately.
              Amber = plan to use within 30 days or risk waste. */}
          {item.expiryDate && isExpired(item.expiryDate) && (
            <span className="ml-2 text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">
              EXPIRED
            </span>
          )}
          {item.expiryDate && isExpiringSoon(item.expiryDate) && (
            <span className="ml-2 text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">
              EXPIRING SOON
            </span>
          )}
        </>
      );

    case 'notes':
      return item.notes || '-';

    default:
      return '-';
  }
}

export default GenericStockTab;
