/**
 * useEdgeFlowState - Tag-driven edge flow animation hook
 *
 * Determines whether a SCADA edge should animate based on its
 * EdgeFlowConfig and the current value of the bound process tag.
 *
 * Architecture:
 * - Subscribes to TagValueBus via ScadaRuntimeContext
 * - Evaluates the configured flow condition against the live tag value
 * - Returns { isFlowing, speed, direction } for the edge renderer
 *
 * Backward compatibility:
 * - When no flowConfig is provided, the hook is inert (isFlowing = false).
 * - The caller (ScreenCanvas) still falls back to the static `animated`
 *   flag when flowConfig is absent, preserving existing behavior.
 */

import { useState, useEffect, useContext } from 'react';
import { ScadaRuntimeContext } from '../../../engine/ScadaRuntime';
import type { EdgeFlowConfig } from '../../../types/scada-edge.types';

/** Default animation duration in seconds when no speed is configured */
const DEFAULT_FLOW_SPEED = 2;

export interface EdgeFlowState {
  /** Whether the edge should currently animate (show flow) */
  isFlowing: boolean;
  /** Animation duration in seconds (lower = faster visual flow) */
  speed: number;
  /** Direction of the flow animation ('forward' or 'reverse') */
  direction: 'forward' | 'reverse';
}

/**
 * Evaluate whether a tag value meets the configured flow condition.
 */
function evaluateFlowCondition(
  value: unknown,
  condition: EdgeFlowConfig['flowCondition'],
): boolean {
  if (condition === 'always') return true;

  if (condition === 'boolean') {
    // Truthy check: 1, true, "on", "true", non-zero numbers
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === 'on' || lower === '1';
    }
    return false;
  }

  if (condition === 'nonZero') {
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const num = Number(value);
      return !isNaN(num) && num !== 0;
    }
    return false;
  }

  return false;
}

/**
 * Determine flow direction based on tag value and config.
 */
function evaluateDirection(
  value: unknown,
  reverseOnNegative?: boolean,
): 'forward' | 'reverse' {
  if (!reverseOnNegative) return 'forward';
  if (typeof value === 'number' && value < 0) return 'reverse';
  return 'forward';
}

/**
 * Hook that determines if an edge should animate based on its
 * flow configuration and the current tag value from the TagValueBus.
 *
 * Usage in edge components:
 *   const { isFlowing, speed, direction } = useEdgeFlowState(data?.flowConfig);
 *
 * The hook safely handles the case where ScadaRuntimeContext is not
 * available (e.g. in storybook or unit tests) by returning a static
 * non-flowing state.
 */
export function useEdgeFlowState(flowConfig?: EdgeFlowConfig): EdgeFlowState {
  const runtimeCtx = useContext(ScadaRuntimeContext);
  const tagBus = runtimeCtx?.tagBus ?? null;

  const [tagValue, setTagValue] = useState<unknown>(() => {
    if (!flowConfig?.tagName || !tagBus) return undefined;
    return tagBus.getLatest(flowConfig.tagName);
  });

  // Subscribe to the controlling tag on the TagValueBus
  useEffect(() => {
    if (!flowConfig?.tagName || !tagBus) return;

    // Read the current value immediately (may have changed since mount)
    setTagValue(tagBus.getLatest(flowConfig.tagName));

    const unsub = tagBus.subscribe(flowConfig.tagName, (val: unknown) => {
      setTagValue(val);
    });

    return unsub;
  }, [flowConfig?.tagName, tagBus]);

  // No flow config means the hook is inert
  if (!flowConfig) {
    return { isFlowing: false, speed: DEFAULT_FLOW_SPEED, direction: 'forward' };
  }

  const condition = flowConfig.flowCondition ?? 'always';
  const isFlowing = evaluateFlowCondition(tagValue, condition);
  const speed = flowConfig.flowSpeed ?? DEFAULT_FLOW_SPEED;
  const direction = evaluateDirection(tagValue, flowConfig.reverseOnNegative);

  return { isFlowing, speed, direction };
}

// Re-export for tests
export { evaluateFlowCondition, evaluateDirection, DEFAULT_FLOW_SPEED };
