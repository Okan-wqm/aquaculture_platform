/**
 * useThresholdCheck Hook
 * Monitors Norwegian regulatory thresholds and triggers alerts
 *
 * Provides:
 * - Check values against regulatory thresholds
 * - Get severity classification
 * - Determine if reporting is required
 * - Format threshold messages
 */
import { useMemo, useCallback } from 'react';
import {
  MORTALITY_THRESHOLDS,
  MORTALITY_SEVERITY,
  SEA_LICE_THRESHOLDS,
  SEA_LICE_SEVERITY,
  calculateMortalitySeverity,
  calculateSeaLiceSeverity,
  requiresImmediateReport,
} from '../utils/thresholds';

// ============================================================================
// Types
// ============================================================================

export type ThresholdSeverity = 'normal' | 'elevated' | 'high' | 'critical' | 'mass';

export interface ThresholdCheckResult {
  /** Current severity level */
  severity: ThresholdSeverity;
  /** Whether the value exceeds threshold */
  exceeds: boolean;
  /** Whether regulatory reporting is required */
  requiresReport: boolean;
  /** Human-readable message */
  message: string;
  /** Color for display */
  color: 'green' | 'yellow' | 'orange' | 'red';
  /** Threshold value that was exceeded (if any) */
  threshold?: number;
  /** Percentage above threshold */
  percentageAbove?: number;
}

export interface MortalityThresholdInput {
  /** Daily mortality rate (%) */
  dailyRate?: number;
  /** 3-day mortality rate (%) */
  threeDayRate?: number;
  /** 7-day mortality rate (%) */
  sevenDayRate?: number;
}

export interface SeaLiceThresholdInput {
  /** Adult female lice per fish */
  adultFemalePerFish: number;
  /** Total mobile lice per fish */
  mobilePerFish?: number;
}

export interface UseThresholdCheckReturn {
  /** Check mortality against thresholds */
  checkMortality: (input: MortalityThresholdInput) => ThresholdCheckResult;
  /** Check sea lice against thresholds */
  checkSeaLice: (input: SeaLiceThresholdInput) => ThresholdCheckResult;
  /** Get severity color */
  getSeverityColor: (severity: ThresholdSeverity) => string;
  /** Get severity badge classes */
  getSeverityBadgeClasses: (severity: ThresholdSeverity) => string;
  /** Check if immediate action required */
  requiresImmediateAction: (severity: ThresholdSeverity) => boolean;
  /** Mortality thresholds for reference */
  mortalityThresholds: typeof MORTALITY_THRESHOLDS;
  /** Sea lice thresholds for reference */
  seaLiceThresholds: typeof SEA_LICE_THRESHOLDS;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useThresholdCheck(): UseThresholdCheckReturn {
  /**
   * Check mortality against thresholds
   */
  const checkMortality = useCallback(
    (input: MortalityThresholdInput): ThresholdCheckResult => {
      const { dailyRate, threeDayRate, sevenDayRate } = input;

      // Check worst case across all periods
      let worstSeverity: ThresholdSeverity = 'normal';
      let worstRate = 0;
      let worstThreshold = 0;
      let worstPeriod = '';

      // Check daily rate
      if (dailyRate !== undefined) {
        const severity = calculateMortalitySeverity(dailyRate).toLowerCase() as ThresholdSeverity;
        if (getSeverityPriority(severity) > getSeverityPriority(worstSeverity)) {
          worstSeverity = severity;
          worstRate = dailyRate;
          worstThreshold = MORTALITY_THRESHOLDS.DAILY.ELEVATED;
          worstPeriod = 'daily';
        }
      }

      // Check 3-day rate
      if (threeDayRate !== undefined && threeDayRate > MORTALITY_THRESHOLDS.MULTI_DAY.THREE_DAY_HIGH) {
        const severity: ThresholdSeverity = 'high';
        if (getSeverityPriority(severity) > getSeverityPriority(worstSeverity)) {
          worstSeverity = severity;
          worstRate = threeDayRate;
          worstThreshold = MORTALITY_THRESHOLDS.MULTI_DAY.THREE_DAY_HIGH;
          worstPeriod = '3-day';
        }
      }

      // Check 7-day rate
      if (sevenDayRate !== undefined && sevenDayRate > MORTALITY_THRESHOLDS.MULTI_DAY.SEVEN_DAY_CRITICAL) {
        const severity: ThresholdSeverity = 'critical';
        if (getSeverityPriority(severity) > getSeverityPriority(worstSeverity)) {
          worstSeverity = severity;
          worstRate = sevenDayRate;
          worstThreshold = MORTALITY_THRESHOLDS.MULTI_DAY.SEVEN_DAY_CRITICAL;
          worstPeriod = '7-day';
        }
      }

      const requiresReport = dailyRate ? requiresImmediateReport(dailyRate) : false;
      const exceeds = worstSeverity !== 'normal';

      return {
        severity: worstSeverity,
        exceeds,
        requiresReport: requiresReport || worstSeverity === 'critical' || worstSeverity === 'mass',
        message: getmortalityMessage(worstSeverity, worstRate, worstPeriod),
        color: getSeverityDisplayColor(worstSeverity),
        threshold: exceeds ? worstThreshold : undefined,
        percentageAbove: exceeds && worstThreshold > 0
          ? Math.round(((worstRate - worstThreshold) / worstThreshold) * 100)
          : undefined,
      };
    },
    []
  );

  /**
   * Check sea lice against thresholds
   */
  const checkSeaLice = useCallback((input: SeaLiceThresholdInput): ThresholdCheckResult => {
    const { adultFemalePerFish } = input;
    const severity = calculateSeaLiceSeverity(adultFemalePerFish).toLowerCase() as ThresholdSeverity;

    const exceeds = severity !== 'normal';
    const threshold = exceeds ? SEA_LICE_THRESHOLDS.ALERT_LEVEL : undefined;

    return {
      severity,
      exceeds,
      requiresReport: adultFemalePerFish >= SEA_LICE_THRESHOLDS.TREATMENT_TRIGGER,
      message: getSeaLiceMessage(severity, adultFemalePerFish),
      color: getSeverityDisplayColor(severity),
      threshold,
      percentageAbove:
        exceeds && threshold
          ? Math.round(((adultFemalePerFish - threshold) / threshold) * 100)
          : undefined,
    };
  }, []);

  /**
   * Get severity color
   */
  const getSeverityColor = useCallback((severity: ThresholdSeverity): string => {
    const colors = {
      normal: 'green',
      elevated: 'yellow',
      high: 'orange',
      critical: 'red',
      mass: 'red',
    };
    return colors[severity];
  }, []);

  /**
   * Get severity badge classes
   */
  const getSeverityBadgeClasses = useCallback((severity: ThresholdSeverity): string => {
    const classes = {
      normal: 'bg-green-100 text-green-800',
      elevated: 'bg-yellow-100 text-yellow-800',
      high: 'bg-orange-100 text-orange-800',
      critical: 'bg-red-100 text-red-800',
      mass: 'bg-red-200 text-red-900',
    };
    return classes[severity];
  }, []);

  /**
   * Check if immediate action required
   */
  const requiresImmediateAction = useCallback((severity: ThresholdSeverity): boolean => {
    return severity === 'critical' || severity === 'mass';
  }, []);

  return {
    checkMortality,
    checkSeaLice,
    getSeverityColor,
    getSeverityBadgeClasses,
    requiresImmediateAction,
    mortalityThresholds: MORTALITY_THRESHOLDS,
    seaLiceThresholds: SEA_LICE_THRESHOLDS,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get priority number for severity comparison
 */
function getSeverityPriority(severity: ThresholdSeverity): number {
  const priorities = {
    normal: 0,
    elevated: 1,
    high: 2,
    critical: 3,
    mass: 4,
  };
  return priorities[severity];
}

/**
 * Get display color for severity
 */
function getSeverityDisplayColor(severity: ThresholdSeverity): 'green' | 'yellow' | 'orange' | 'red' {
  const colors: Record<ThresholdSeverity, 'green' | 'yellow' | 'orange' | 'red'> = {
    normal: 'green',
    elevated: 'yellow',
    high: 'orange',
    critical: 'red',
    mass: 'red',
  };
  return colors[severity];
}

/**
 * Get mortality threshold message
 */
function getmortalityMessage(
  severity: ThresholdSeverity,
  rate: number,
  period: string
): string {
  if (severity === 'normal') {
    return 'Mortality rate within acceptable limits';
  }

  const messages = {
    elevated: `${period} mortality rate (${rate.toFixed(1)}%) is elevated. Monitor closely.`,
    high: `${period} mortality rate (${rate.toFixed(1)}%) exceeds threshold. Reporting recommended.`,
    critical: `CRITICAL: ${period} mortality rate (${rate.toFixed(1)}%) requires immediate reporting.`,
    mass: `EMERGENCY: Mass mortality event detected (${rate.toFixed(1)}%). Immediate action required.`,
  };

  return messages[severity] || 'Unknown severity level';
}

/**
 * Get sea lice threshold message
 */
function getSeaLiceMessage(severity: ThresholdSeverity, perFish: number): string {
  if (severity === 'normal') {
    return 'Sea lice count within acceptable limits';
  }

  const messages = {
    elevated: `Adult female lice (${perFish.toFixed(2)}/fish) is elevated. Monitor closely.`,
    high: `Adult female lice (${perFish.toFixed(2)}/fish) exceeds alert threshold. Action recommended.`,
    critical: `CRITICAL: Adult female lice (${perFish.toFixed(2)}/fish) requires treatment.`,
    mass: `Adult female lice at critical level`,
  };

  return messages[severity] || 'Unknown severity level';
}

export default useThresholdCheck;
