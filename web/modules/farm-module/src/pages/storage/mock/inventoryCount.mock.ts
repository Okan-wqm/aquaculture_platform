import { InventoryCount } from '../types/storage.types';

export const inventoryCounts: InventoryCount[] = [
  {
    id: 'ic1', countNumber: 'IC-2026-003', locationName: 'Main Warehouse', status: 'COMPLETED', countDate: '2026-02-01', completedDate: '2026-02-01',
    items: [
      { id: 'ici1', itemName: 'Predator Net 20mm', expectedQty: 10, countedQty: 8, variance: -2, unit: 'pcs' },
      { id: 'ici2', itemName: 'Polyethylene Rope 16mm', expectedQty: 1200, countedQty: 1200, variance: 0, unit: 'm' },
      { id: 'ici3', itemName: 'Fish Transport Box 50kg', expectedQty: 462, countedQty: 450, variance: -12, unit: 'pcs' },
      { id: 'ici4', itemName: 'Underwater LED Light 200W', expectedQty: 17, countedQty: 15, variance: -2, unit: 'pcs' },
    ],
    totalVariance: -16, performedBy: 'Erik Berg', approvedBy: 'Lars Hansen',
  },
  {
    id: 'ic2', countNumber: 'IC-2026-004', locationName: 'Chemical Store', status: 'IN_PROGRESS', countDate: '2026-02-06',
    items: [
      { id: 'ici5', itemName: 'Hydrogen Peroxide 35%', expectedQty: 32, countedQty: 12, variance: -20, unit: 'L' },
      { id: 'ici6', itemName: 'Formaldehyde 37%', expectedQty: 200, countedQty: 200, variance: 0, unit: 'L' },
      { id: 'ici7', itemName: 'SLICE Premix', expectedQty: 5, countedQty: 3, variance: -2, unit: 'kg' },
    ],
    totalVariance: -22, performedBy: 'Kari Olsen',
  },
  {
    id: 'ic3', countNumber: 'IC-2026-005', locationName: 'Feed Silo A', status: 'PLANNED', countDate: '2026-02-10',
    items: [],
    totalVariance: 0, performedBy: 'Lars Hansen',
  },
];
