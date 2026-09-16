/**
 * animationsAdapter — maps BUILDER animation rules (engine/animation,
 * `AnimationRule`) onto RUNTIME tag-driven actions (`WidgetAction`).
 *
 * Mapping matrix (explicit; anything without a row degrades VISIBLY via
 * `warnings` rather than silently changing widget behavior):
 *
 *   colorRange          → one `color` action per ColorRange
 *   rotate              → degrade (continuous rotation is a builder-canvas
 *                         engine feature; the runtime wrapper supports
 *                         value-mapped angles only)
 *   blink               → `blink`
 *   hide / show         → `hide` / `show`
 *   move                → `move`
 *   valueMappedRotation → `rotate` (minAngle/maxAngle)
 *   fillLevel           → degrade (runtime widgets render tank levels from
 *                         their own config, not from a generic action)
 *   piston, imageAlongPath, recursiveColor, scale, opacity,
 *   videoPlayback, textFormat → degrade (no runtime equivalent)
 *
 * `rule.tagName` is reduced to the device-local tag name (the runtime keys
 * all live data by local names) via the shared widgetBinding helper.
 */

import type { AnimationRule } from '../../../engine/animation/types';
import type { WidgetAction } from '../../../types/scada-runtime.types';
import { localTagFromBindingValue } from '../../../engine/tags/widgetBinding';

export interface AdaptedAnimations {
  actions: WidgetAction[];
  /** Visible degradation notes for rules without a runtime mapping. */
  warnings: string[];
}

export function adaptAnimationRules(rules: AnimationRule[] | undefined): AdaptedAnimations {
  if (!rules || rules.length === 0) {
    return { actions: [], warnings: [] };
  }

  const actions: WidgetAction[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    const tagId = localTagFromBindingValue(rule.tagName);
    const base = {
      tagId,
      bitmask: rule.bitmask,
      range: rule.range,
    };

    switch (rule.type) {
      case 'colorRange': {
        for (const range of rule.options.ranges ?? []) {
          actions.push({
            id: `${rule.id}:${range.min}-${range.max}`,
            ...base,
            range: { min: range.min, max: range.max },
            type: 'color',
            params: { fill: range.fill, stroke: range.stroke ?? range.fill },
          });
        }
        break;
      }

      case 'blink': {
        actions.push({
          id: rule.id,
          ...base,
          type: 'blink',
          params: {
            fillA: rule.options.fillA ?? '#ffffff',
            fillB: rule.options.fillB ?? '#ff0000',
            strokeA: rule.options.strokeA ?? '#ffffff',
            strokeB: rule.options.strokeB ?? '#ff0000',
            intervalMs: rule.options.blinkInterval ?? 500,
          },
        });
        break;
      }

      case 'hide':
      case 'show': {
        actions.push({
          id: rule.id,
          ...base,
          type: rule.type,
          params: {},
        });
        break;
      }

      case 'move': {
        actions.push({
          id: rule.id,
          ...base,
          type: 'move',
          params: {
            toX: rule.options.toX ?? 0,
            toY: rule.options.toY ?? 0,
            durationMs: rule.options.duration ?? 0,
          },
        });
        break;
      }

      case 'valueMappedRotation': {
        actions.push({
          id: rule.id,
          ...base,
          type: 'rotate',
          params: {
            minAngle: rule.options.minAngle ?? 0,
            maxAngle: rule.options.maxAngle ?? 360,
          },
        });
        break;
      }

      default: {
        warnings.push(
          `animationsAdapter: animation rule "${rule.id}" (type ${rule.type}) has no runtime mapping — visual effect degraded`,
        );
        break;
      }
    }
  }

  return { actions, warnings };
}
