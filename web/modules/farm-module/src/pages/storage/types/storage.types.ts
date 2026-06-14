/**
 * Storage & Stock Management Types
 */

// ============================================================================
// ENUMS
// ============================================================================

export type ConsumableCategory =
  | 'NET' | 'ROPE' | 'PPE' | 'SPARE_PART' | 'OXYGEN'
  | 'PACKAGING' | 'CLEANING' | 'TOOL' | 'ELECTRICAL' | 'PIPE_FITTING' | 'OTHER';

export type FishHealthCategory =
  | 'ANTIPARASITIC' | 'ANTIBIOTIC' | 'ANTIFUNGAL' | 'VACCINE' | 'ANESTHETIC'
  | 'DISINFECTANT' | 'PROBIOTIC' | 'VITAMIN' | 'WOUND_CARE' | 'OTHER';

export type StorageLocationType =
  | 'WAREHOUSE' | 'COLD_ROOM' | 'CHEMICAL_STORE' | 'FEED_SILO' | 'OUTDOOR' | 'HAZMAT';

export type StockMovementType =
  | 'IN' | 'OUT' | 'TRANSFER' | 'WASTE' | 'ADJUSTMENT' | 'RETURN';

// Canonical PO status vocabulary — reconciled to the backend PurchaseOrderStatus
// enum and the hand-maintained enum in hooks/usePurchaseOrders.ts. The legacy
// 'PENDING' / 'PARTIAL' tokens were divergent fictions: the real maker-checker
// flow is DRAFT -> SUBMITTED -> APPROVED -> ORDERED -> PARTIALLY_RECEIVED -> RECEIVED
// (plus terminal CANCELLED).
export type PurchaseOrderStatus =
  | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'ORDERED'
  | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export type InventoryCountStatus =
  | 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'APPROVED';

export type ItemStatus = 'AVAILABLE' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'EXPIRED' | 'DISCONTINUED';

// ============================================================================
// INTERFACES
// ============================================================================

export interface ConsumableItem {
  id: string;
  name: string;
  code: string;
  category: ConsumableCategory;
  unit: string;
  description: string;
  supplierName: string;
  minStock: number;
  currentStock: number;
  unitPrice: number;
  currency: string;
  status: ItemStatus;
  isActive: boolean;
}

export interface FishHealthChemical {
  id: string;
  name: string;
  code: string;
  category: FishHealthCategory;
  activeIngredient: string;
  concentration: string;
  formulation: string;
  unit: string;
  supplierName: string;
  withdrawalPeriodDays: number;
  prescriptionRequired: boolean;
  targetConditions: string[];
  storageRequirements: string;
  status: ItemStatus;
  isActive: boolean;
}

export interface StorageLocation {
  id: string;
  name: string;
  code: string;
  type: StorageLocationType;
  capacity: number;
  capacityUnit: string;
  usedCapacity: number;
  temperatureMin?: number;
  temperatureMax?: number;
  humidityControl: boolean;
  description: string;
  isActive: boolean;
}

export interface StockMovement {
  id: string;
  date: string;
  type: StockMovementType;
  itemName: string;
  itemCategory: string;
  quantity: number;
  unit: string;
  fromLocation?: string;
  toLocation?: string;
  performedBy: string;
  reference?: string;
  notes?: string;
}

export interface PurchaseOrderItem {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  items: PurchaseOrderItem[];
  totalAmount: number;
  currency: string;
  orderDate: string;
  expectedDelivery?: string;
  receivedDate?: string;
  notes?: string;
  // Maker-checker audit trail (SOC2 CC3.4) — set when the PO reaches APPROVED.
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: string;
}

export interface InventoryCountItem {
  id: string;
  itemName: string;
  expectedQty: number;
  countedQty: number;
  variance: number;
  unit: string;
}

export interface InventoryCount {
  id: string;
  countNumber: string;
  locationName: string;
  status: InventoryCountStatus;
  countDate: string;
  completedDate?: string;
  items: InventoryCountItem[];
  totalVariance: number;
  performedBy: string;
  approvedBy?: string;
  notes?: string;
}

export interface FeedStockItem {
  id: string;
  name: string;
  brand: string;
  type: string;
  lotNumber: string;
  quantity: number;
  unit: string;
  location: string;
  expiryDate: string;
  pelletSize: string;
  status: ItemStatus;
}

export interface ChemicalStockItem {
  id: string;
  name: string;
  category: string;
  activeIngredient: string;
  quantity: number;
  unit: string;
  location: string;
  expiryDate: string;
  withdrawalDays: number;
  status: ItemStatus;
}

export interface OverviewStats {
  totalStockValue: number;
  currency: string;
  lowStockAlerts: number;
  pendingOrders: number;
  recentMovements: number;
  totalItems: number;
  totalLocations: number;
}

export interface LowStockAlert {
  id: string;
  itemName: string;
  category: string;
  currentStock: number;
  minStock: number;
  unit: string;
  severity: 'warning' | 'critical';
}
