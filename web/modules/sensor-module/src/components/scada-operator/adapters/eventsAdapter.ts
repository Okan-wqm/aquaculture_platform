/**
 * eventsAdapter — maps BUILDER widget event definitions (engine/events,
 * `WidgetEventDef`) onto RUNTIME event bindings (`WidgetEventBinding`).
 *
 * Field mapping (explicit, per architect demand):
 *   def.params.targetScreenId → binding.params.screenId
 *   def.params.targetTag       → binding.params.tagId
 *   def.action                 → binding.action (see ACTION_MAP)
 *
 * Unmapped builder actions (setProperty — mutating another widget's config
 * at runtime is not supported by the operator renderer) and unmapped params
 * are reported in `warnings` so the caller can surface them visibly instead
 * of silently dropping behavior.
 */

import type { WidgetEventDef } from '../../../engine/events/types';
import type { WidgetEventBinding } from '../../../types/scada-runtime.types';
import { localTagFromBindingValue } from '../../../engine/tags/widgetBinding';

/** Reduce a builder tag reference to the device-local name the runtime keys on. */
function localTag(value: string | undefined): string {
  return value ? localTagFromBindingValue(value) : '';
}

export interface AdaptedEvents {
  events: WidgetEventBinding[];
  /** Visible degradation notes (unmapped actions / dropped fields). */
  warnings: string[];
}

export function adaptWidgetEvents(defs: WidgetEventDef[] | undefined): AdaptedEvents {
  if (!defs || defs.length === 0) {
    return { events: [], warnings: [] };
  }

  const events: WidgetEventBinding[] = [];
  const warnings: string[] = [];

  for (const def of defs) {
    const p = def.params ?? {};
    let binding: WidgetEventBinding | null = null;

    switch (def.action) {
      case 'navigate':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'navigate',
          params: { type: 'navigate', screenId: p.targetScreenId ?? '' },
        };
        break;

      case 'openCard':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'openCard',
          params: { type: 'openCard', screenId: p.targetScreenId ?? '' },
        };
        break;

      case 'openDialog':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'openDialog',
          params: { type: 'openDialog', screenId: p.targetScreenId ?? '', position: 'center' },
        };
        break;

      case 'openUrl':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'openTab',
          params: { type: 'openTab', url: p.url ?? '' },
        };
        break;

      case 'setValue':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'setValue',
          params: { type: 'setValue', tagId: localTag(p.targetTag), value: p.value },
        };
        break;

      case 'toggleValue':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'toggleValue',
          params: {
            type: 'toggleValue',
            tagId: localTag(p.toggleTag ?? p.targetTag),
          },
        };
        break;

      case 'runScript':
        if (!p.scriptId) {
          warnings.push(
            `eventsAdapter: runScript event "${def.id}" has no scriptId — dropped`,
          );
          break;
        }
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'runScript',
          params: { type: 'runScript', scriptId: p.scriptId },
        };
        break;

      case 'closeDialog':
        binding = {
          id: def.id,
          trigger: def.trigger,
          action: 'close',
          params: { type: 'close' },
        };
        break;

      default:
        warnings.push(
          `eventsAdapter: action "${def.action}" (event "${def.id}") has no runtime mapping — dropped`,
        );
        break;
    }

    if (binding) {
      // Note visibly which builder params could not be carried over.
      if (p.variableMap && Object.keys(p.variableMap).length > 0) {
        warnings.push(
          `eventsAdapter: event "${def.id}" variableMap is not mapped at runtime — dropped`,
        );
      }
      if (def.action === 'openCard' && (p.width !== undefined || p.height !== undefined)) {
        warnings.push(
          `eventsAdapter: event "${def.id}" openCard width/height are not mapped at runtime — dropped`,
        );
      }
      events.push(binding);
    }
  }

  return { events, warnings };
}
