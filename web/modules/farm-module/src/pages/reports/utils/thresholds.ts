/**
 * Norwegian Regulatory Thresholds
 *
 * All threshold values required for Norwegian aquaculture
 * regulatory compliance.
 *
 * Sources:
 * - Mattilsynet (Norwegian Food Safety Authority)
 * - Fiskeridirektoratet (Directorate of Fisheries)
 * - Norwegian regulations for aquaculture
 */

// ============================================================================
// Contact Information
// ============================================================================

export const REGULATORY_CONTACTS = {
  MATTILSYNET_EMAIL: 'varsling.akva@mattilsynet.no',
  FISKERIDIREKTORATET_EMAIL: 'postmottak@fiskeridir.no',
} as const;

// ============================================================================
// Sea Lice Thresholds
// ============================================================================

export const SEA_LICE_THRESHOLDS = {
  /** Alert level - adult female lice per fish */
  ALERT_LEVEL: 0.5,

  /** Treatment trigger - adult female lice per fish */
  TREATMENT_TRIGGER: 1.0,

  /** Maximum allowed before mandatory action */
  MAX_ALLOWED: 2.0,

  /** Weekly monitoring is mandatory */
  MONITORING_FREQUENCY_DAYS: 7,

  /** Reporting deadline - every Tuesday */
  REPORTING_DAY: 2, // 0 = Sunday, 2 = Tuesday
} as const;



// ============================================================================
// Mortality Thresholds (Mattilsynet)
// ============================================================================

export const MORTALITY_THRESHOLDS = {
  /** Daily mortality rate thresholds */
  DAILY: {
    NORMAL: 0.5,      // < 0.5% is normal
    ELEVATED: 0.5,    // >= 0.5% triggers ELEVATED alert
    HIGH: 1.0,        // >= 1.0% over 3 days triggers HIGH alert
    CRITICAL: 5.0,    // >= 5% triggers CRITICAL (immediate report)
    MASS: 10.0,       // >= 10% is mass mortality (EMERGENCY)
  },

  /** Multi-day mortality rate thresholds */
  MULTI_DAY: {
    THREE_DAY_HIGH: 1.0,    // > 1% over 3 days
    SEVEN_DAY_CRITICAL: 2.0, // > 2% over 7 days
  },
} as const;



// ============================================================================
// Welfare Indicators
// ============================================================================



// ============================================================================
// Disease Classification (Norwegian Lists)
// ============================================================================

export const DISEASE_LISTS = {
  /** Liste A - Exotic diseases (immediate report required) */
  A: {
    label: 'Liste A - Exotic',
    description: 'Serious exotic diseases not present in Norway',
    reportingDeadline: 'IMMEDIATE',
    diseases: [
      { code: 'ISA', name: 'Infectious Salmon Anemia', norwegianName: 'Infeksiøs lakseanemi (ILA)' },
      { code: 'IHN', name: 'Infectious Hematopoietic Necrosis', norwegianName: 'Infeksiøs hematopoietisk nekrose' },
      { code: 'VHS', name: 'Viral Hemorrhagic Septicemia', norwegianName: 'Viral hemoragisk septikemi' },
      { code: 'SVC', name: 'Spring Viraemia of Carp', norwegianName: 'Vårviremi hos karpe' },
      { code: 'KHV', name: 'Koi Herpesvirus Disease', norwegianName: 'Koi herpesvirus sykdom' },
    ],
  },

  /** Liste C - Non-exotic notifiable diseases */
  C: {
    label: 'Liste C - Non-exotic',
    description: 'Non-exotic diseases subject to control measures',
    reportingDeadline: 'IMMEDIATE',
    diseases: [
      { code: 'PD', name: 'Pancreas Disease', norwegianName: 'Pankreassykdom' },
      { code: 'BKD', name: 'Bacterial Kidney Disease', norwegianName: 'Bakteriell nyresyke' },
      { code: 'IPN', name: 'Infectious Pancreatic Necrosis', norwegianName: 'Infeksiøs pankreasnekrose' },
      { code: 'FURUNCULOSIS', name: 'Furunculosis', norwegianName: 'Furunkulose' },
      { code: 'VER', name: 'Viral Encephalopathy and Retinopathy', norwegianName: 'Viral encefalopati og retinopati' },
    ],
  },

  /** Liste F - Other notifiable diseases */
  F: {
    label: 'Liste F - Other',
    description: 'Other diseases requiring notification',
    reportingDeadline: 'WITHIN_24_HOURS',
    diseases: [
      { code: 'CMS', name: 'Cardiomyopathy Syndrome', norwegianName: 'Kardiomyopatisyndrom' },
      { code: 'HSMI', name: 'Heart and Skeletal Muscle Inflammation', norwegianName: 'Hjerte- og skjelettmuskelbetennelse' },
      { code: 'AGD', name: 'Amoebic Gill Disease', norwegianName: 'Amøbisk gjellesykdom' },
      { code: 'PGI', name: 'Proliferative Gill Inflammation', norwegianName: 'Proliferativ gjellebetennelse' },
      { code: 'WINTER_ULCERS', name: 'Winter Ulcers', norwegianName: 'Vintersår' },
    ],
  },
} as const;

/** Disease code to list mapping */


// ============================================================================
// Reporting Deadlines
// ============================================================================

export const REPORTING_DEADLINES = {
  /** Sea Lice - Every Tuesday */
  SEA_LICE: {
    frequency: 'weekly',
    dayOfWeek: 2, // Tuesday
    description: 'Weekly sea lice count due every Tuesday',
  },

  /** Biomass - 7th of each month */
  BIOMASS: {
    frequency: 'monthly',
    dayOfMonth: 7,
    description: 'Monthly biomass report due by the 7th',
  },

  /** Smolt - 7th of each month */
  SMOLT: {
    frequency: 'monthly',
    dayOfMonth: 7,
    description: 'Monthly smolt report due by the 7th',
  },

  /** Cleaner Fish - 7th of each month */
  CLEANER_FISH: {
    frequency: 'monthly',
    dayOfMonth: 7,
    description: 'Monthly cleaner fish report due by the 7th',
  },

  /** Slaughter - Event-based */
  SLAUGHTER: {
    frequency: 'event-based',
    description: 'Report planned and completed slaughters',
  },

  /** Welfare Events - Immediate */
  WELFARE: {
    frequency: 'immediate',
    description: 'Report immediately when threshold is exceeded',
  },

  /** Disease Outbreak - Immediate */
  DISEASE: {
    frequency: 'immediate',
    description: 'Report immediately upon detection/suspicion',
  },

  /** Escape - Immediate */
  ESCAPE: {
    frequency: 'immediate',
    description: 'Report immediately upon detection',
  },
} as const;

// ============================================================================
// Cleaner Fish Species
// ============================================================================



// ============================================================================
// Escape Report Categories
// ============================================================================

export const ESCAPE_CAUSES = {
  EQUIPMENT_FAILURE: {
    code: 'equipment_failure',
    label: 'Equipment Failure',
    norwegianLabel: 'Utstyrssvikt',
    description: 'Net damage, mooring failure, structural issues',
  },
  STORM_DAMAGE: {
    code: 'storm_damage',
    label: 'Storm Damage',
    norwegianLabel: 'Stormskade',
    description: 'Weather-related damage causing escape',
  },
  PREDATOR_ATTACK: {
    code: 'predator_attack',
    label: 'Predator Attack',
    norwegianLabel: 'Rovdyrangrep',
    description: 'Seal or other predator causing net damage',
  },
  HUMAN_ERROR: {
    code: 'human_error',
    label: 'Human Error',
    norwegianLabel: 'Menneskelig feil',
    description: 'Operational mistakes or accidents',
  },
  UNKNOWN: {
    code: 'unknown',
    label: 'Unknown',
    norwegianLabel: 'Ukjent',
    description: 'Cause not yet determined',
  },
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate mortality severity based on daily rate
 */




export function getNextDeadline(reportType: keyof typeof REPORTING_DEADLINES): Date {
  const config = REPORTING_DEADLINES[reportType];
  const now = new Date();

  if (config.frequency === 'weekly' && 'dayOfWeek' in config) {
    const daysUntilDeadline = (config.dayOfWeek - now.getDay() + 7) % 7;
    const deadline = new Date(now);
    deadline.setDate(now.getDate() + (daysUntilDeadline === 0 ? 7 : daysUntilDeadline));
    deadline.setHours(23, 59, 59, 999);
    return deadline;
  }

  if (config.frequency === 'monthly' && 'dayOfMonth' in config) {
    const deadline = new Date(now.getFullYear(), now.getMonth(), config.dayOfMonth, 23, 59, 59, 999);
    if (deadline <= now) {
      deadline.setMonth(deadline.getMonth() + 1);
    }
    return deadline;
  }

  // BUG-013: event-based/immediate reports have no fixed deadline.
  // Returning `now` would cause getDaysUntilDeadline() = 0 → "Due Today" which is misleading.
  // Return a far-future sentinel date so callers can detect this case.
  const farFuture = new Date(now);
  farFuture.setFullYear(farFuture.getFullYear() + 100);
  return farFuture;
}

/**
 * Get days remaining until deadline
 */
export function getDaysUntilDeadline(deadline: Date): number {
  const now = new Date();
  const diffTime = deadline.getTime() - now.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Check if deadline is overdue
 */
export function isDeadlineOverdue(deadline: Date): boolean {
  return new Date() > deadline;
}

/**
 * Check if deadline is urgent (within 3 days)
 */
export function isDeadlineUrgent(deadline: Date): boolean {
  const daysRemaining = getDaysUntilDeadline(deadline);
  return daysRemaining >= 0 && daysRemaining <= 3;
}
