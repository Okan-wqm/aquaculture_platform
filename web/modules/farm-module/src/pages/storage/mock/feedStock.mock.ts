import { FeedStockItem } from '../types/storage.types';

export const feedStockItems: FeedStockItem[] = [
  { id: 'f1', name: 'Nutra Olympic 3mm', brand: 'Skretting', type: 'Grower', lotNumber: 'SK-2026-0142', quantity: 2400, unit: 'kg', location: 'Feed Silo A', expiryDate: '2026-08-15', pelletSize: '3mm', status: 'AVAILABLE' },
  { id: 'f2', name: 'Nutra Olympic 5mm', brand: 'Skretting', type: 'Grower', lotNumber: 'SK-2026-0143', quantity: 3200, unit: 'kg', location: 'Feed Silo B', expiryDate: '2026-09-20', pelletSize: '5mm', status: 'AVAILABLE' },
  { id: 'f3', name: 'INTRO 1.5mm', brand: 'BioMar', type: 'Starter', lotNumber: 'BM-2026-0087', quantity: 180, unit: 'kg', location: 'Cold Room 1', expiryDate: '2026-06-10', pelletSize: '1.5mm', status: 'LOW_STOCK' },
  { id: 'f4', name: 'EFICO Sigma 780 7mm', brand: 'BioMar', type: 'Finisher', lotNumber: 'BM-2026-0091', quantity: 4800, unit: 'kg', location: 'Feed Silo C', expiryDate: '2026-11-05', pelletSize: '7mm', status: 'AVAILABLE' },
  { id: 'f5', name: 'Spirit Supreme 9mm', brand: 'Skretting', type: 'Broodstock', lotNumber: 'SK-2026-0155', quantity: 850, unit: 'kg', location: 'Feed Silo A', expiryDate: '2026-07-28', pelletSize: '9mm', status: 'AVAILABLE' },
  { id: 'f6', name: 'Micro Balance 0.5mm', brand: 'Cargill', type: 'Fry', lotNumber: 'CG-2026-0034', quantity: 45, unit: 'kg', location: 'Cold Room 1', expiryDate: '2026-04-18', pelletSize: '0.5mm', status: 'EXPIRED' },
];
