import { StockMovement } from '../types/storage.types';

export const stockMovements: StockMovement[] = [
  { id: 'm1', date: '2026-02-06T09:15:00', type: 'IN', itemName: 'Nutra Olympic 5mm', itemCategory: 'Feed', quantity: 2000, unit: 'kg', toLocation: 'Feed Silo B', performedBy: 'Lars Hansen', reference: 'PO-2026-042' },
  { id: 'm2', date: '2026-02-06T08:30:00', type: 'OUT', itemName: 'Hydrogen Peroxide 35%', itemCategory: 'Chemical', quantity: 20, unit: 'L', fromLocation: 'Chemical Store', performedBy: 'Kari Olsen', notes: 'Treatment Cage 4' },
  { id: 'm3', date: '2026-02-05T16:45:00', type: 'TRANSFER', itemName: 'Nitrile Gloves (L)', itemCategory: 'PPE', quantity: 10, unit: 'box', fromLocation: 'Main Warehouse', toLocation: 'Site Office', performedBy: 'Erik Berg' },
  { id: 'm4', date: '2026-02-05T14:20:00', type: 'OUT', itemName: 'SLICE Premix', itemCategory: 'Fish Health', quantity: 2, unit: 'kg', fromLocation: 'Chemical Store', performedBy: 'Dr. Anna Svendsen', reference: 'RX-2026-015' },
  { id: 'm5', date: '2026-02-05T11:00:00', type: 'IN', itemName: 'Polyethylene Rope 16mm', itemCategory: 'Consumable', quantity: 500, unit: 'm', toLocation: 'Main Warehouse', performedBy: 'Lars Hansen', reference: 'PO-2026-041' },
  { id: 'm6', date: '2026-02-05T09:30:00', type: 'WASTE', itemName: 'Micro Balance 0.5mm', itemCategory: 'Feed', quantity: 45, unit: 'kg', fromLocation: 'Cold Room 1', performedBy: 'Kari Olsen', notes: 'Expired - disposed per protocol' },
  { id: 'm7', date: '2026-02-04T15:00:00', type: 'OUT', itemName: 'Aqui-S', itemCategory: 'Chemical', quantity: 5, unit: 'L', fromLocation: 'Cold Room 2', performedBy: 'Dr. Anna Svendsen', notes: 'Grading operation Cage 2' },
  { id: 'm8', date: '2026-02-04T13:30:00', type: 'ADJUSTMENT', itemName: 'Fish Transport Box 50kg', itemCategory: 'Packaging', quantity: -12, unit: 'pcs', fromLocation: 'Main Warehouse', performedBy: 'Erik Berg', notes: 'Physical count correction' },
  { id: 'm9', date: '2026-02-04T10:15:00', type: 'IN', itemName: 'PHARMAQ Alpha Ject', itemCategory: 'Vaccine', quantity: 500, unit: 'dose', toLocation: 'Cold Room 1', performedBy: 'Lars Hansen', reference: 'PO-2026-039' },
  { id: 'm10', date: '2026-02-03T16:00:00', type: 'OUT', itemName: 'Chlorine Tablets', itemCategory: 'Cleaning', quantity: 5, unit: 'kg', fromLocation: 'Main Warehouse', performedBy: 'Kari Olsen', notes: 'Weekly equipment wash' },
  { id: 'm11', date: '2026-02-03T14:00:00', type: 'RETURN', itemName: 'Pump Impeller Kit', itemCategory: 'Spare Part', quantity: 1, unit: 'pcs', toLocation: 'Main Warehouse', performedBy: 'Erik Berg', notes: 'Wrong size - returned to stock' },
  { id: 'm12', date: '2026-02-03T09:00:00', type: 'OUT', itemName: 'Nutra Olympic 3mm', itemCategory: 'Feed', quantity: 400, unit: 'kg', fromLocation: 'Feed Silo A', performedBy: 'Lars Hansen', notes: 'Daily feeding' },
  { id: 'm13', date: '2026-02-02T15:30:00', type: 'TRANSFER', itemName: 'Formaldehyde 37%', itemCategory: 'Chemical', quantity: 20, unit: 'L', fromLocation: 'Hazmat Storage', toLocation: 'Chemical Store', performedBy: 'Kari Olsen' },
  { id: 'm14', date: '2026-02-02T10:00:00', type: 'IN', itemName: 'Predator Net 20mm', itemCategory: 'Net', quantity: 3, unit: 'pcs', toLocation: 'Main Warehouse', performedBy: 'Lars Hansen', reference: 'PO-2026-038' },
  { id: 'm15', date: '2026-02-01T12:00:00', type: 'OUT', itemName: 'Underwater LED Light 200W', itemCategory: 'Electrical', quantity: 2, unit: 'pcs', fromLocation: 'Main Warehouse', performedBy: 'Erik Berg', notes: 'Cage 6 light replacement' },
];
