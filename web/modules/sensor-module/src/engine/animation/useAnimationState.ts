import { useMemo } from 'react';
import type { AnimationRule, AnimationState } from './types';
import { DEFAULT_ANIMATION_STATE } from './types';
import { evaluate } from './AnimationEngine';

export function useAnimationState(
  rules: AnimationRule[] | undefined,
  tagValues: Record<string, unknown>,
): AnimationState {
  return useMemo(() => {
    if (!rules || rules.length === 0) return DEFAULT_ANIMATION_STATE;
    return evaluate(rules, tagValues);
  }, [rules, tagValues]);
}
