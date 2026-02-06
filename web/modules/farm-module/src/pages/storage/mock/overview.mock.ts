import { OverviewStats, LowStockAlert } from '../types/storage.types';

export const overviewStats: OverviewStats = {
  totalStockValue: 1_245_800,
  currency: 'NOK',
  lowStockAlerts: 5,
  pendingOrders: 3,
  recentMovements: 24,
  totalItems: 187,
  totalLocations: 6,
};

export const lowStockAlerts: LowStockAlert[] = [
  { id: '1', itemName: 'Hydrogen Peroxide 35%', category: 'Chemical', currentStock: 12, minStock: 50, unit: 'L', severity: 'critical' },
  { id: '2', itemName: 'Nitrile Gloves (L)', category: 'PPE', currentStock: 45, minStock: 100, unit: 'box', severity: 'warning' },
  { id: '3', itemName: 'Skretting Nutra 3mm', category: 'Feed', currentStock: 180, minStock: 500, unit: 'kg', severity: 'critical' },
  { id: '4', itemName: 'Net Repair Kit', category: 'Consumable', currentStock: 2, minStock: 5, unit: 'pcs', severity: 'warning' },
  { id: '5', itemName: 'SLICE Premix', category: 'Fish Health', currentStock: 3, minStock: 10, unit: 'kg', severity: 'critical' },
];
