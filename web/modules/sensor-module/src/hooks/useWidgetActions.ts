/**
 * useWidgetActions — Evaluate tag-value-driven widget actions at runtime.
 *
 * For each WidgetAction the hook:
 *  1. Reads the current TagValueChange for action.tagId from tagValues.
 *  2. Applies action.bitmask (if present) via bitwise AND before comparison.
 *  3. Checks whether the resulting numeric value falls within action.range.
 *  4. If so, applies the action effect to the accumulated visual state.
 *
 * Visual state computed:
 *  - isHidden / blink timer (setInterval, cleaned up on unmount)
 *  - color (fill + stroke)
 *  - rotation angle (linear interpolation across range)
 *  - translation offset
 *  - pipe animation direction
 *
 * Multiple actions of the same type are resolved in array order: the last
 * matching action wins.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  WidgetAction,
  TagValueChange,
  PipeFlowDirection,
  BlinkParams,
  ColorParams,
  RotateParams,
  MoveParams,
  AnimateParams,
} from '../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Return type                                                         */
/* ------------------------------------------------------------------ */

export interface WidgetActionsResult {
  isHidden: boolean;
  isBlinking: boolean;
  blinkState: boolean;
  currentColor: { fill?: string; stroke?: string } | null;
  rotation: number;
  translation: { x: number; y: number } | null;
  animationDirection: PipeFlowDirection;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function lerp(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

function applyBitmask(value: number | string | boolean, bitmask?: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (bitmask === undefined || bitmask === 0) return isNaN(num) ? 0 : num;
  return (isNaN(num) ? 0 : Math.trunc(num)) & bitmask;
}

function isInRange(numericValue: number, range: { min: number; max: number }): boolean {
  return numericValue >= range.min && numericValue <= range.max;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useWidgetActions(
  actions: WidgetAction[] | undefined,
  tagValues: Record<string, TagValueChange>,
): WidgetActionsResult {
  // Blink timer state: controlled by setInterval.
  const [blinkState, setBlinkState] = useState(false);
  const blinkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const targetBlinkIntervalMsRef = useRef<number | null>(null);

  // -----------------------------------------------------------------------
  // Evaluate all actions and accumulate the visual state.
  // Memoized on the actions array and all relevant tag values so it only
  // recomputes when something meaningful changes.
  // -----------------------------------------------------------------------

  const tagValuesKey = useMemo(
    () =>
      actions
        ? actions.map((a) => `${a.tagId}:${tagValues[a.tagId]?.value}`).join('|')
        : '',
    [actions, tagValues],
  );

  const computed = useMemo(() => {
    const result = {
      isHidden: false,
      isBlinking: false,
      blinkIntervalMs: 500,
      currentColor: null as { fill?: string; stroke?: string } | null,
      rotation: 0,
      translation: null as { x: number; y: number } | null,
      animationDirection: 'stop' as PipeFlowDirection,
    };

    if (!actions || actions.length === 0) return result;

    for (const action of actions) {
      const tagChange = tagValues[action.tagId];
      if (!tagChange) continue;

      const rawValue = tagChange.value;
      const numericValue = applyBitmask(rawValue, action.bitmask);

      if (!isInRange(numericValue, action.range)) continue;

      switch (action.type) {
        case 'hide':
          result.isHidden = true;
          break;

        case 'show':
          // Explicit show overrides a previous hide.
          result.isHidden = false;
          break;

        case 'blink': {
          const bp = action.params as BlinkParams;
          result.isBlinking = true;
          result.blinkIntervalMs = bp.intervalMs > 0 ? bp.intervalMs : 500;
          // Store blink colors for rendering (blinkState determines which set).
          result.currentColor = {
            fill:   bp.fillA,
            stroke: bp.strokeA,
          };
          break;
        }

        case 'color': {
          const cp = action.params as ColorParams;
          result.currentColor = { fill: cp.fill, stroke: cp.stroke };
          break;
        }

        case 'rotate': {
          const rp = action.params as RotateParams;
          result.rotation = lerp(
            numericValue,
            action.range.min,
            action.range.max,
            rp.minAngle,
            rp.maxAngle,
          );
          break;
        }

        case 'move': {
          const mp = action.params as MoveParams;
          // Interpolate X and Y proportionally across the range.
          const t = action.range.max === action.range.min
            ? 0
            : Math.max(0, Math.min(1, (numericValue - action.range.min) / (action.range.max - action.range.min)));
          result.translation = {
            x: mp.toX * t,
            y: mp.toY * t,
          };
          break;
        }

        case 'animate': {
          const ap = action.params as AnimateParams;
          result.animationDirection =
            ap.direction === 'clockwise'
              ? 'forward'
              : ap.direction === 'anticlockwise'
                ? 'reverse'
                : 'stop';
          break;
        }

        case 'refreshImage':
          // No visual state change; handled by the widget renderer directly.
          break;

        default:
          break;
      }
    }

    return result;
   
  }, [tagValuesKey, actions]);

  // -----------------------------------------------------------------------
  // Blink interval management.
  // -----------------------------------------------------------------------

  // We track the blink params that were active during the last blink action
  // so we can toggle between fillA/fillB.
  const blinkParamsRef = useRef<BlinkParams | null>(null);

  // Update blink params ref whenever the computed state changes.
  useEffect(() => {
    if (computed.isBlinking && actions) {
      for (const action of actions) {
        if (action.type === 'blink') {
          const tagChange = tagValues[action.tagId];
          if (tagChange) {
            const numericValue = applyBitmask(tagChange.value, action.bitmask);
            if (isInRange(numericValue, action.range)) {
              blinkParamsRef.current = action.params as BlinkParams;
              break;
            }
          }
        }
      }
    } else {
      blinkParamsRef.current = null;
    }
  }, [computed.isBlinking, actions, tagValues]);

  // Manage interval lifecycle.
  const startBlink = useCallback((intervalMs: number) => {
    if (blinkIntervalRef.current !== null) {
      if (targetBlinkIntervalMsRef.current === intervalMs) return; // unchanged
      clearInterval(blinkIntervalRef.current);
    }
    targetBlinkIntervalMsRef.current = intervalMs;
    blinkIntervalRef.current = setInterval(() => {
      setBlinkState((prev) => !prev);
    }, intervalMs);
  }, []);

  const stopBlink = useCallback(() => {
    if (blinkIntervalRef.current !== null) {
      clearInterval(blinkIntervalRef.current);
      blinkIntervalRef.current = null;
      targetBlinkIntervalMsRef.current = null;
    }
    setBlinkState(false);
  }, []);

  useEffect(() => {
    if (computed.isBlinking) {
      startBlink(computed.blinkIntervalMs);
    } else {
      stopBlink();
    }
  }, [computed.isBlinking, computed.blinkIntervalMs, startBlink, stopBlink]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (blinkIntervalRef.current !== null) {
        clearInterval(blinkIntervalRef.current);
      }
    };
  }, []);

  // -----------------------------------------------------------------------
  // Compute blinkState-driven color for blink actions.
  // -----------------------------------------------------------------------
  const effectiveColor = useMemo(() => {
    if (!computed.isBlinking || !blinkParamsRef.current) {
      return computed.currentColor;
    }
    const bp = blinkParamsRef.current;
    return blinkState
      ? { fill: bp.fillB, stroke: bp.strokeB }
      : { fill: bp.fillA, stroke: bp.strokeA };
  // blinkParamsRef is a ref so we also depend on computed.isBlinking to re-evaluate
   
  }, [blinkState, computed.isBlinking, computed.currentColor]);

  return {
    isHidden:          computed.isHidden,
    isBlinking:        computed.isBlinking,
    blinkState,
    currentColor:      effectiveColor,
    rotation:          computed.rotation,
    translation:       computed.translation,
    animationDirection: computed.animationDirection,
  };
}
