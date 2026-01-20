/**
 * Chemical Types Seed Data
 */

export interface ChemicalTypeSeed {
  name: string;
  code: string;
  description: string;
  icon?: string;
  sortOrder: number;
}

export const CHEMICAL_TYPES_SEED: ChemicalTypeSeed[] = [
  {
    name: 'Disinfectant',
    code: 'disinfectant',
    description: 'Disinfection and sanitization chemicals',
    icon: 'disinfectant',
    sortOrder: 1,
  },
  {
    name: 'Treatment',
    code: 'treatment',
    description: 'Fish treatment and medication chemicals',
    icon: 'treatment',
    sortOrder: 2,
  },
  {
    name: 'Water Conditioner',
    code: 'water_conditioner',
    description: 'Water quality conditioning chemicals',
    icon: 'water',
    sortOrder: 3,
  },
  {
    name: 'Antibiotic',
    code: 'antibiotic',
    description: 'Antibiotic medications',
    icon: 'antibiotic',
    sortOrder: 4,
  },
  {
    name: 'Antiparasitic',
    code: 'antiparasitic',
    description: 'Antiparasitic treatments',
    icon: 'antiparasitic',
    sortOrder: 5,
  },
  {
    name: 'Probiotic',
    code: 'probiotic',
    description: 'Probiotic supplements',
    icon: 'probiotic',
    sortOrder: 6,
  },
  {
    name: 'Vitamin',
    code: 'vitamin',
    description: 'Vitamin supplements',
    icon: 'vitamin',
    sortOrder: 7,
  },
  {
    name: 'Mineral',
    code: 'mineral',
    description: 'Mineral supplements',
    icon: 'mineral',
    sortOrder: 8,
  },
  {
    name: 'Anesthetic',
    code: 'anesthetic',
    description: 'Anesthetic agents for fish handling',
    icon: 'anesthetic',
    sortOrder: 9,
  },
  {
    name: 'pH Adjuster',
    code: 'ph_adjuster',
    description: 'pH adjustment chemicals',
    icon: 'ph',
    sortOrder: 10,
  },
  {
    name: 'Algaecide',
    code: 'algaecide',
    description: 'Algae control chemicals',
    icon: 'algae',
    sortOrder: 11,
  },
  {
    name: 'Other',
    code: 'other',
    description: 'Other types of chemicals',
    icon: 'other',
    sortOrder: 99,
  },
];
