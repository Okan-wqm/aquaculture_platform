/**
 * Supplier Types Seed Data
 */

export interface SupplierTypeSeed {
  name: string;
  code: string;
  description: string;
  icon?: string;
  sortOrder: number;
}

export const SUPPLIER_TYPES_SEED: SupplierTypeSeed[] = [
  {
    name: 'Fry Supplier',
    code: 'fry',
    description: 'Fish fry and fingerling suppliers',
    icon: 'fish',
    sortOrder: 1,
  },
  {
    name: 'Feed Supplier',
    code: 'feed',
    description: 'Fish feed and nutrition suppliers',
    icon: 'feed',
    sortOrder: 2,
  },
  {
    name: 'Equipment Supplier',
    code: 'equipment',
    description: 'Aquaculture equipment and machinery suppliers',
    icon: 'equipment',
    sortOrder: 3,
  },
  {
    name: 'Chemical Supplier',
    code: 'chemical',
    description: 'Water treatment chemicals and medications suppliers',
    icon: 'chemical',
    sortOrder: 4,
  },
  {
    name: 'Service Provider',
    code: 'service',
    description: 'Maintenance, consulting and other service providers',
    icon: 'service',
    sortOrder: 5,
  },
  {
    name: 'Other',
    code: 'other',
    description: 'Other types of suppliers',
    icon: 'other',
    sortOrder: 99,
  },
];
