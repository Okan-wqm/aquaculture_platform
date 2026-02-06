import { ChemicalStockItem } from '../types/storage.types';

export const chemicalStockItems: ChemicalStockItem[] = [
  { id: 'c1', name: 'Hydrogen Peroxide 35%', category: 'Disinfectant', activeIngredient: 'H2O2', quantity: 12, unit: 'L', location: 'Chemical Store', expiryDate: '2026-12-31', withdrawalDays: 0, status: 'LOW_STOCK' },
  { id: 'c2', name: 'Formaldehyde 37%', category: 'Disinfectant', activeIngredient: 'CH2O', quantity: 200, unit: 'L', location: 'Hazmat Storage', expiryDate: '2027-03-15', withdrawalDays: 14, status: 'AVAILABLE' },
  { id: 'c3', name: 'SLICE Premix', category: 'Antiparasitic', activeIngredient: 'Emamectin Benzoate', quantity: 3, unit: 'kg', location: 'Chemical Store', expiryDate: '2026-09-30', withdrawalDays: 175, status: 'LOW_STOCK' },
  { id: 'c4', name: 'Alphamax', category: 'Antiparasitic', activeIngredient: 'Deltamethrin', quantity: 50, unit: 'L', location: 'Chemical Store', expiryDate: '2026-11-20', withdrawalDays: 7, status: 'AVAILABLE' },
  { id: 'c5', name: 'Aqui-S', category: 'Anesthetic', activeIngredient: 'Isoeugenol', quantity: 25, unit: 'L', location: 'Cold Room 2', expiryDate: '2027-01-15', withdrawalDays: 1, status: 'AVAILABLE' },
  { id: 'c6', name: 'Oxytetracycline 20%', category: 'Antibiotic', activeIngredient: 'OTC', quantity: 15, unit: 'kg', location: 'Cold Room 2', expiryDate: '2026-08-10', withdrawalDays: 80, status: 'AVAILABLE' },
  { id: 'c7', name: 'PHARMAQ Alpha Ject', category: 'Vaccine', activeIngredient: 'Inactivated A. salmonicida', quantity: 500, unit: 'dose', location: 'Cold Room 1', expiryDate: '2026-05-01', withdrawalDays: 450, status: 'AVAILABLE' },
  { id: 'c8', name: 'Bronopol 50%', category: 'Antifungal', activeIngredient: 'Bronopol', quantity: 8, unit: 'L', location: 'Chemical Store', expiryDate: '2026-10-15', withdrawalDays: 0, status: 'AVAILABLE' },
];
