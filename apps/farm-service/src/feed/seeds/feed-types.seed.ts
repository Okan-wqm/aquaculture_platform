/**
 * Feed Types Seed Data
 */

export interface FeedTypeSeed {
  name: string;
  code: string;
  description: string;
  icon?: string;
  sortOrder: number;
}

export const FEED_TYPES_SEED: FeedTypeSeed[] = [
  {
    name: 'Starter',
    code: 'starter',
    description: 'Starter feed for juvenile fish',
    icon: 'starter',
    sortOrder: 1,
  },
  {
    name: 'Grower',
    code: 'grower',
    description: 'Growth feed for developing fish',
    icon: 'grower',
    sortOrder: 2,
  },
  {
    name: 'Finisher',
    code: 'finisher',
    description: 'Finisher feed for market-ready fish',
    icon: 'finisher',
    sortOrder: 3,
  },
  {
    name: 'Broodstock',
    code: 'broodstock',
    description: 'Feed for broodstock and breeders',
    icon: 'broodstock',
    sortOrder: 4,
  },
  {
    name: 'Medicated',
    code: 'medicated',
    description: 'Medicated feed for treatment',
    icon: 'medicated',
    sortOrder: 5,
  },
  {
    name: 'Larval',
    code: 'larval',
    description: 'Feed for larval stage fish',
    icon: 'larval',
    sortOrder: 6,
  },
  {
    name: 'Fry',
    code: 'fry',
    description: 'Feed for fry stage fish',
    icon: 'fry',
    sortOrder: 7,
  },
  {
    name: 'High Energy',
    code: 'high_energy',
    description: 'High energy feed for cold water conditions',
    icon: 'energy',
    sortOrder: 8,
  },
  {
    name: 'Low FCR',
    code: 'low_fcr',
    description: 'Feed optimized for low feed conversion ratio',
    icon: 'fcr',
    sortOrder: 9,
  },
  {
    name: 'Organic',
    code: 'organic',
    description: 'Certified organic feed',
    icon: 'organic',
    sortOrder: 10,
  },
  {
    name: 'Other',
    code: 'other',
    description: 'Other types of feed',
    icon: 'other',
    sortOrder: 99,
  },
];
