import { colors } from '@aquaculture/shared-contracts';
export interface ParameterTemplateEntry {
  code: string;
  name: string;
  unit: string;
  dataType: 'number' | 'enum' | 'boolean';
  precision: number;
  group: 'basic' | 'nitrogen_cycle' | 'metals' | 'biological' | 'organic' | 'custom';
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  chartColor: string;
  displayOrder: number;
  isVisible: boolean;
  isRequired: boolean;
  chartAxisGroup: 'left' | 'right';
  enumValues?: string[];
}

export interface ParameterTemplate {
  templateId: string;
  name: string;
  description: string;
  species: string[];
  parameters: ParameterTemplateEntry[];
}

const p = (
  code: string, name: string, unit: string, precision: number,
  group: ParameterTemplateEntry['group'],
  optMin: number | null, optMax: number | null,
  warnMin: number | null, warnMax: number | null,
  critMin: number | null, critMax: number | null,
  color: string, order: number,
  required: boolean, axis: 'left' | 'right' = 'left',
  dataType: ParameterTemplateEntry['dataType'] = 'number',
  enumValues?: string[],
): ParameterTemplateEntry => ({
  code, name, unit, dataType, precision, group,
  optimalMin: optMin, optimalMax: optMax,
  warningMin: warnMin, warningMax: warnMax,
  criticalMin: critMin, criticalMax: critMax,
  chartColor: color, displayOrder: order,
  isVisible: true, isRequired: required, chartAxisGroup: axis,
  ...(enumValues ? { enumValues } : {}),
});

/* ------------------------------------------------------------------ */
/*  1. Salmon Freshwater  (15 params)                                 */
/* ------------------------------------------------------------------ */
const salmonFreshwater: ParameterTemplate = {
  templateId: 'salmon_freshwater',
  name: 'Salmon Freshwater',
  description: 'Cold-water salmonid production in freshwater RAS, flow-through, or cage systems. Covers Atlantic salmon, rainbow trout, Arctic charr, and brown trout.',
  species: ['atlantic_salmon', 'rainbow_trout', 'arctic_charr', 'brown_trout'],
  parameters: [
    p('temperature', 'Temperature', '\u00B0C', 1, 'basic', 10, 16, 6, 20, 2, 25, colors.info[500], 1, true, 'left'),
    p('dissolved_oxygen', 'Dissolved Oxygen', 'mg/L', 1, 'basic', 7, 11, 5.5, 13, 4, 15, colors.success[500], 2, true, 'left'),
    p('ph', 'pH', '', 2, 'basic', 6.5, 8.0, 6.0, 8.5, 5.5, 9.0, colors.accent[400], 3, true, 'left'),
    p('ammonia', 'Ammonia (NH\u2083)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.02, 0, 0.04, 0, 0.05, colors.error[500], 4, true, 'right'),
    p('nitrite', 'Nitrite (NO\u2082)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.1, 0, 0.3, 0, 0.5, colors.accent[500], 5, true, 'right'),
    p('nitrate', 'Nitrate (NO\u2083)', 'mg/L', 1, 'nitrogen_cycle', 0, 50, 0, 80, 0, 100, colors.warning[500], 6, true, 'right'),
    p('co2', 'Carbon Dioxide', 'mg/L', 1, 'basic', 0, 15, 0, 25, 0, 40, colors.info[300], 7, false, 'right'),
    p('alkalinity', 'Alkalinity', 'mg/L CaCO\u2083', 0, 'basic', 50, 150, 30, 200, 20, 300, colors.accent[300], 8, false, 'left'),
    p('hardness', 'Hardness', 'mg/L CaCO\u2083', 0, 'basic', 50, 200, 30, 300, 20, 400, colors.accent[800], 9, false, 'left'),
    p('turbidity', 'Turbidity', 'NTU', 1, 'basic', 0, 5, 0, 15, 0, 30, colors.neutral[400], 10, false, 'left'),
    p('conductivity', 'Conductivity', '\u00B5S/cm', 0, 'basic', 100, 500, 50, 800, 20, 1200, colors.info[200], 11, false, 'right'),
    p('total_ammonia_nitrogen', 'Total Ammonia Nitrogen', 'mg/L', 2, 'nitrogen_cycle', 0, 0.5, 0, 1.0, 0, 2.0, colors.error[600], 12, false, 'right'),
    p('oxygen_saturation', 'Oxygen Saturation', '%', 0, 'basic', 80, 110, 60, 120, 40, 130, colors.success[600], 13, false, 'left'),
    p('transparency', 'Transparency', 'cm', 0, 'basic', 50, 200, 30, 250, 15, 300, colors.info[400], 14, false, 'left'),
    p('chlorine', 'Chlorine', 'mg/L', 3, 'basic', 0, 0.003, 0, 0.005, 0, 0.01, colors.error[400], 15, false, 'right'),
  ],
};

/* ------------------------------------------------------------------ */
/*  2. Salmon Seawater  (14 params)                                   */
/* ------------------------------------------------------------------ */
const salmonSeawater: ParameterTemplate = {
  templateId: 'salmon_seawater',
  name: 'Salmon Seawater',
  description: 'Marine-phase Atlantic salmon production in sea cages or land-based seawater RAS. Optimised for post-smolt and grow-out stages.',
  species: ['atlantic_salmon'],
  parameters: [
    p('temperature', 'Temperature', '\u00B0C', 1, 'basic', 8, 14, 4, 18, 1, 22, colors.info[500], 1, true, 'left'),
    p('dissolved_oxygen', 'Dissolved Oxygen', 'mg/L', 1, 'basic', 7, 10, 5, 12, 3.5, 14, colors.success[500], 2, true, 'left'),
    p('ph', 'pH', '', 2, 'basic', 7.5, 8.2, 7.0, 8.5, 6.5, 9.0, colors.accent[400], 3, true, 'left'),
    p('salinity', 'Salinity', 'ppt', 1, 'basic', 30, 35, 25, 38, 20, 40, colors.info[300], 4, true, 'left'),
    p('ammonia', 'Ammonia (NH\u2083)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.02, 0, 0.04, 0, 0.05, colors.error[500], 5, true, 'right'),
    p('nitrite', 'Nitrite (NO\u2082)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.1, 0, 0.3, 0, 0.5, colors.accent[500], 6, true, 'right'),
    p('nitrate', 'Nitrate (NO\u2083)', 'mg/L', 1, 'nitrogen_cycle', 0, 50, 0, 80, 0, 100, colors.warning[500], 7, false, 'right'),
    p('co2', 'Carbon Dioxide', 'mg/L', 1, 'basic', 0, 12, 0, 20, 0, 35, colors.neutral[300], 8, false, 'right'),
    p('alkalinity', 'Alkalinity', 'mg/L CaCO\u2083', 0, 'basic', 80, 150, 60, 200, 40, 300, colors.accent[300], 9, false, 'left'),
    p('turbidity', 'Turbidity', 'NTU', 1, 'basic', 0, 5, 0, 15, 0, 30, colors.neutral[400], 10, false, 'left'),
    p('h2s', 'Hydrogen Sulfide', '\u00B5g/L', 1, 'basic', 0, 5, 0, 15, 0, 25, colors.error[700], 11, false, 'right'),
    p('total_ammonia_nitrogen', 'Total Ammonia Nitrogen', 'mg/L', 2, 'nitrogen_cycle', 0, 0.5, 0, 1.0, 0, 2.0, colors.error[600], 12, false, 'right'),
    p('oxygen_saturation', 'Oxygen Saturation', '%', 0, 'basic', 80, 110, 60, 120, 40, 130, colors.success[600], 13, false, 'left'),
    p('chlorine', 'Chlorine', 'mg/L', 3, 'basic', 0, 0.003, 0, 0.005, 0, 0.01, colors.error[400], 14, false, 'right'),
  ],
};

/* ------------------------------------------------------------------ */
/*  3. Sea Bass / Sea Bream  (12 params)                              */
/* ------------------------------------------------------------------ */
const seaBass: ParameterTemplate = {
  templateId: 'sea_bass',
  name: 'Sea Bass / Sea Bream',
  description: 'Warm-water marine finfish production for European sea bass, gilthead sea bream, and turbot in cages or land-based systems.',
  species: ['sea_bass', 'sea_bream', 'turbot'],
  parameters: [
    p('temperature', 'Temperature', '\u00B0C', 1, 'basic', 18, 24, 14, 28, 10, 32, colors.info[500], 1, true, 'left'),
    p('dissolved_oxygen', 'Dissolved Oxygen', 'mg/L', 1, 'basic', 6, 9, 4.5, 11, 3, 14, colors.success[500], 2, true, 'left'),
    p('ph', 'pH', '', 2, 'basic', 7.5, 8.5, 7.0, 9.0, 6.5, 9.5, colors.accent[400], 3, true, 'left'),
    p('salinity', 'Salinity', 'ppt', 1, 'basic', 15, 38, 10, 40, 5, 42, colors.info[300], 4, true, 'left'),
    p('ammonia', 'Ammonia (NH\u2083)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.03, 0, 0.06, 0, 0.1, colors.error[500], 5, true, 'right'),
    p('nitrite', 'Nitrite (NO\u2082)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.15, 0, 0.5, 0, 1.0, colors.accent[500], 6, true, 'right'),
    p('nitrate', 'Nitrate (NO\u2083)', 'mg/L', 1, 'nitrogen_cycle', 0, 60, 0, 100, 0, 150, colors.warning[500], 7, false, 'right'),
    p('co2', 'Carbon Dioxide', 'mg/L', 1, 'basic', 0, 15, 0, 25, 0, 40, colors.neutral[300], 8, false, 'right'),
    p('turbidity', 'Turbidity', 'NTU', 1, 'basic', 0, 8, 0, 20, 0, 40, colors.neutral[400], 9, false, 'left'),
    p('alkalinity', 'Alkalinity', 'mg/L CaCO\u2083', 0, 'basic', 80, 200, 50, 300, 30, 400, colors.accent[300], 10, false, 'left'),
    p('oxygen_saturation', 'Oxygen Saturation', '%', 0, 'basic', 75, 110, 55, 120, 35, 130, colors.success[600], 11, false, 'left'),
    p('ozone', 'Ozone', 'mg/L', 2, 'custom', 0, 0.05, 0, 0.08, 0, 0.1, colors.accent[700], 12, false, 'right'),
  ],
};

/* ------------------------------------------------------------------ */
/*  4. Shrimp Vannamei  (16 params)                                   */
/* ------------------------------------------------------------------ */
const shrimp: ParameterTemplate = {
  templateId: 'shrimp',
  name: 'Shrimp Vannamei',
  description: 'Tropical penaeid shrimp production for Litopenaeus vannamei and Penaeus monodon in intensive or super-intensive pond and biofloc systems.',
  species: ['vannamei', 'monodon'],
  parameters: [
    p('temperature', 'Temperature', '\u00B0C', 1, 'basic', 26, 32, 22, 34, 18, 36, colors.info[500], 1, true, 'left'),
    p('dissolved_oxygen', 'Dissolved Oxygen', 'mg/L', 1, 'basic', 5, 9, 3.5, 12, 2, 15, colors.success[500], 2, true, 'left'),
    p('ph', 'pH', '', 2, 'basic', 7.5, 8.5, 7.0, 9.0, 6.5, 9.5, colors.accent[400], 3, true, 'left'),
    p('salinity', 'Salinity', 'ppt', 1, 'basic', 15, 25, 5, 35, 2, 40, colors.info[300], 4, true, 'left'),
    p('ammonia', 'Ammonia (NH\u2083)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.03, 0, 0.1, 0, 0.2, colors.error[500], 5, true, 'right'),
    p('nitrite', 'Nitrite (NO\u2082)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.25, 0, 0.5, 0, 1.0, colors.accent[500], 6, true, 'right'),
    p('alkalinity', 'Alkalinity', 'mg/L CaCO\u2083', 0, 'basic', 80, 200, 50, 300, 30, 400, colors.accent[300], 7, false, 'left'),
    p('nitrate', 'Nitrate (NO\u2083)', 'mg/L', 1, 'nitrogen_cycle', 0, 50, 0, 100, 0, 200, colors.warning[500], 8, false, 'right'),
    p('total_ammonia_nitrogen', 'Total Ammonia Nitrogen', 'mg/L', 2, 'nitrogen_cycle', 0, 1.0, 0, 3.0, 0, 5.0, colors.error[600], 9, false, 'right'),
    p('turbidity', 'Turbidity', 'NTU', 1, 'basic', 0, 30, 0, 60, 0, 100, colors.neutral[400], 10, false, 'left'),
    p('bod', 'BOD', 'mg/L', 1, 'organic', 0, 5, 0, 10, 0, 20, colors.success[900], 11, false, 'right'),
    p('cod', 'COD', 'mg/L', 1, 'organic', 0, 20, 0, 40, 0, 80, colors.success[700], 12, false, 'right'),
    p('tss', 'Total Suspended Solids', 'mg/L', 1, 'organic', 0, 25, 0, 50, 0, 100, colors.warning[800], 13, false, 'left'),
    p('bacteria_count', 'Total Bacteria Count', 'CFU/mL', 0, 'biological', 0, 1000, 0, 5000, 0, 10000, colors.error[800], 14, false, 'right'),
    p('vibrio_count', 'Vibrio Count', 'CFU/mL', 0, 'biological', 0, 100, 0, 500, 0, 1000, colors.error[900], 15, false, 'right'),
    p('algae_level', 'Algae Level', '', 0, 'biological', null, null, null, null, null, null, colors.success[300], 16, false, 'left', 'enum', ['none', 'low', 'moderate', 'high', 'bloom']),
  ],
};

/* ------------------------------------------------------------------ */
/*  5. Tilapia  (11 params)                                           */
/* ------------------------------------------------------------------ */
const tilapia: ParameterTemplate = {
  templateId: 'tilapia',
  name: 'Tilapia',
  description: 'Warm-water freshwater tilapia production for Nile tilapia and related species in ponds, cages, or RAS.',
  species: ['tilapia', 'nile_tilapia'],
  parameters: [
    p('temperature', 'Temperature', '\u00B0C', 1, 'basic', 25, 30, 20, 34, 15, 38, colors.info[500], 1, true, 'left'),
    p('dissolved_oxygen', 'Dissolved Oxygen', 'mg/L', 1, 'basic', 5, 10, 3, 13, 1.5, 15, colors.success[500], 2, true, 'left'),
    p('ph', 'pH', '', 2, 'basic', 6.5, 9.0, 6.0, 9.5, 5.5, 10.0, colors.accent[400], 3, true, 'left'),
    p('ammonia', 'Ammonia (NH\u2083)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.05, 0, 0.1, 0, 0.2, colors.error[500], 4, true, 'right'),
    p('nitrite', 'Nitrite (NO\u2082)', 'mg/L', 3, 'nitrogen_cycle', 0, 0.25, 0, 0.5, 0, 1.0, colors.accent[500], 5, true, 'right'),
    p('nitrate', 'Nitrate (NO\u2083)', 'mg/L', 1, 'nitrogen_cycle', 0, 60, 0, 100, 0, 200, colors.warning[500], 6, false, 'right'),
    p('alkalinity', 'Alkalinity', 'mg/L CaCO\u2083', 0, 'basic', 50, 200, 30, 300, 20, 400, colors.accent[300], 7, false, 'left'),
    p('turbidity', 'Turbidity', 'NTU', 1, 'basic', 0, 15, 0, 30, 0, 60, colors.neutral[400], 8, false, 'left'),
    p('total_ammonia_nitrogen', 'Total Ammonia Nitrogen', 'mg/L', 2, 'nitrogen_cycle', 0, 1.0, 0, 2.0, 0, 4.0, colors.error[600], 9, false, 'right'),
    p('co2', 'Carbon Dioxide', 'mg/L', 1, 'basic', 0, 20, 0, 30, 0, 50, colors.neutral[300], 10, false, 'right'),
    p('transparency', 'Transparency', 'cm', 0, 'basic', 25, 60, 15, 80, 10, 120, colors.info[400], 11, false, 'left'),
  ],
};

export const PARAMETER_TEMPLATES: ParameterTemplate[] = [
  salmonFreshwater,
  salmonSeawater,
  seaBass,
  shrimp,
  tilapia,
];

export function getTemplateById(id: string): ParameterTemplate | undefined {
  return PARAMETER_TEMPLATES.find((t) => t.templateId === id);
}
