/**
 * useAlarmEvaluation — Evaluates alarm rules against current tag values.
 *
 * Supports condition operators: gt, lt, gte, lte, eq, ne
 * Supports deadband hysteresis (gt/gte/lt/lte only) and delay debounce.
 *
 * Note: eq/ne conditions use the deadband value as a tolerance band
 * (|current - threshold| <= deadband) rather than strict equality.
 * This avoids floating-point comparison issues common in process values.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { AlarmRuleDef } from '../store/scada';

export interface FiredAlarm {
  ruleId: string;
  severity: AlarmRuleDef['severity'];
  message: string;
  tag: string;
  condition: string;
  threshold: number;
  currentValue: number;
  firedAt: string; // ISO string — safe for Zustand/Immer serialization
}

/** Max delay in seconds to prevent absurdly long timers */
const MAX_DELAY_SEC = 300;

const CONDITION_FNS: Record<string, (current: number, threshold: number) => boolean> = {
  gt: (c, t) => c > t,
  lt: (c, t) => c < t,
  eq: (c, t) => Math.abs(c - t) < 0.001,
  ne: (c, t) => Math.abs(c - t) >= 0.001,
  gte: (c, t) => c >= t,
  lte: (c, t) => c <= t,
};

interface RuleState {
  wasActive: boolean;
  delayTimer: ReturnType<typeof setTimeout> | null;
  confirmedAt: string | null;
}

export function useAlarmEvaluation(
  rules: AlarmRuleDef[],
  getTagValue: (tag: string) => any,
): FiredAlarm[] {
  const [firedAlarms, setFiredAlarms] = useState<FiredAlarm[]>([]);

  // Track per-rule state for deadband hysteresis and delay debounce
  const ruleStateRef = useRef<Map<string, RuleState>>(new Map());

  // Store evaluate in a ref so delay timers always call the latest version
  const evaluateRef = useRef<() => void>(() => {});

  // Cleanup orphan rule states when rules change
  useEffect(() => {
    const stateMap = ruleStateRef.current;
    const activeIds = new Set(rules.map((r) => r.id));
    for (const [id, rs] of stateMap.entries()) {
      if (!activeIds.has(id)) {
        if (rs.delayTimer) clearTimeout(rs.delayTimer);
        stateMap.delete(id);
      }
    }
  }, [rules]);

  // Cleanup all delay timers on unmount
  useEffect(() => {
    return () => {
      for (const rs of ruleStateRef.current.values()) {
        if (rs.delayTimer) clearTimeout(rs.delayTimer);
      }
    };
  }, []);

  const evaluate = useCallback(() => {
    const fired: FiredAlarm[] = [];
    const stateMap = ruleStateRef.current;

    for (const rule of rules) {
      const rawValue = getTagValue(rule.tag);
      const currentValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (isNaN(currentValue)) continue;

      const condFn = CONDITION_FNS[rule.condition];
      if (!condFn) continue;

      let ruleState = stateMap.get(rule.id);
      if (!ruleState) {
        ruleState = { wasActive: false, delayTimer: null, confirmedAt: null };
        stateMap.set(rule.id, ruleState);
      }

      const threshold = rule.value;
      const deadband = rule.deadband ?? 0;

      // Evaluate with deadband hysteresis
      let isTriggered: boolean;
      if (ruleState.wasActive && deadband > 0) {
        // Already active — use deadband to prevent chatter on return-to-normal
        switch (rule.condition) {
          case 'gt':
          case 'gte':
            // Alarm fires at threshold, clears when value drops below threshold - deadband
            isTriggered = currentValue > (threshold - deadband);
            break;
          case 'lt':
          case 'lte':
            // Alarm fires at threshold, clears when value rises above threshold + deadband
            isTriggered = currentValue < (threshold + deadband);
            break;
          case 'eq':
            // Alarm fires within tolerance, clears outside tolerance + deadband
            isTriggered = Math.abs(currentValue - threshold) < (0.001 + deadband);
            break;
          case 'ne':
            // Alarm fires outside tolerance, clears when back within tolerance - deadband
            isTriggered = Math.abs(currentValue - threshold) >= Math.max(0.001, 0.001 - deadband);
            break;
          default:
            isTriggered = condFn(currentValue, threshold);
        }
      } else {
        isTriggered = condFn(currentValue, threshold);
      }

      if (isTriggered) {
        const delay = Math.min(rule.delay ?? 0, MAX_DELAY_SEC);
        if (delay > 0 && !ruleState.wasActive && !ruleState.confirmedAt) {
          // Start delay timer if not already running
          if (!ruleState.delayTimer) {
            ruleState.delayTimer = setTimeout(() => {
              const rs = stateMap.get(rule.id);
              if (rs) {
                rs.confirmedAt = new Date().toISOString();
                rs.delayTimer = null;
              }
              // Trigger re-evaluation via ref (always calls latest version)
              evaluateRef.current();
            }, delay * 1000);
          }
          // Don't fire yet — waiting for delay
          continue;
        }

        ruleState.wasActive = true;
        fired.push({
          ruleId: rule.id,
          severity: rule.severity,
          message: rule.message,
          tag: rule.tag,
          condition: rule.condition,
          threshold,
          currentValue,
          firedAt: ruleState.confirmedAt ?? new Date().toISOString(),
        });
      } else {
        // Not triggered — reset state
        if (ruleState.delayTimer) {
          clearTimeout(ruleState.delayTimer);
          ruleState.delayTimer = null;
        }
        ruleState.wasActive = false;
        ruleState.confirmedAt = null;
      }
    }

    setFiredAlarms(fired);
  }, [rules, getTagValue]);

  // Keep evaluateRef always pointing to latest evaluate
  evaluateRef.current = evaluate;

  // Re-evaluate whenever rules or tag values change
  useEffect(() => {
    evaluate();
  }, [evaluate]);

  return firedAlarms;
}
