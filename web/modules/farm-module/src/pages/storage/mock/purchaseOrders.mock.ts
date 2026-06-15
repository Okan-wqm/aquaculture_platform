import { PurchaseOrder } from '../types/storage.types';

export const purchaseOrders: PurchaseOrder[] = [
  {
    id: 'po1', poNumber: 'PO-2026-043', supplierName: 'Skretting Norge', status: 'ORDERED',
    items: [
      { id: 'poi1', itemName: 'Nutra Olympic 3mm', quantity: 5000, unit: 'kg', unitPrice: 28, totalPrice: 140000 },
      { id: 'poi2', itemName: 'Spirit Supreme 9mm', quantity: 2000, unit: 'kg', unitPrice: 32, totalPrice: 64000 },
    ],
    totalAmount: 204000, currency: 'NOK', orderDate: '2026-02-04', expectedDelivery: '2026-02-10',
  },
  {
    id: 'po2', poNumber: 'PO-2026-044', supplierName: 'SafeWork AS', status: 'SUBMITTED',
    items: [
      { id: 'poi3', itemName: 'Nitrile Gloves (L)', quantity: 200, unit: 'box', unitPrice: 89, totalPrice: 17800 },
      { id: 'poi4', itemName: 'Chemical Goggles', quantity: 20, unit: 'pcs', unitPrice: 350, totalPrice: 7000 },
    ],
    totalAmount: 24800, currency: 'NOK', orderDate: '2026-02-05',
  },
  {
    id: 'po3', poNumber: 'PO-2026-045', supplierName: 'PHARMAQ', status: 'APPROVED',
    items: [
      { id: 'poi5', itemName: 'SLICE Premix', quantity: 20, unit: 'kg', unitPrice: 8500, totalPrice: 170000 },
    ],
    totalAmount: 170000, currency: 'NOK', orderDate: '2026-02-06', expectedDelivery: '2026-02-14',
  },
  {
    id: 'po4', poNumber: 'PO-2026-040', supplierName: 'AquaNet AS', status: 'RECEIVED',
    items: [
      { id: 'poi6', itemName: 'Predator Net 20mm', quantity: 3, unit: 'pcs', unitPrice: 12500, totalPrice: 37500 },
      { id: 'poi7', itemName: 'Net Repair Kit', quantity: 5, unit: 'pcs', unitPrice: 890, totalPrice: 4450 },
    ],
    totalAmount: 41950, currency: 'NOK', orderDate: '2026-01-20', expectedDelivery: '2026-02-02', receivedDate: '2026-02-02',
  },
  {
    id: 'po5', poNumber: 'PO-2026-036', supplierName: 'BioMar', status: 'CANCELLED',
    items: [
      { id: 'poi8', itemName: 'EFICO Sigma 780 7mm', quantity: 3000, unit: 'kg', unitPrice: 30, totalPrice: 90000 },
    ],
    totalAmount: 90000, currency: 'NOK', orderDate: '2026-01-15', notes: 'Cancelled - switched to Skretting',
  },
];
