/**
 * useWidgetEvents — Dispatch widget event bindings based on trigger type.
 *
 * Supported actions:
 *  - navigate      → calls the onNavigate callback with the target screenId.
 *  - openDialog    → opens a dialog-type overlay via the operator store.
 *  - openCard      → opens a card-type overlay at the specified position.
 *  - openTab       → opens the URL in a new browser tab.
 *  - setValue      → writes a tag value via useTagWrite.
 *  - toggleValue   → toggles (with optional bitmask XOR) via useTagWrite.
 *  - runScript     → executes a client-side script via useClientScript.
 *                    (Script is resolved from the store by scriptId; if the
 *                     store integration is unavailable the event is silently
 *                     skipped to avoid crashing the runtime.)
 *  - close         → closes all active overlays.
 *
 * The returned handleEvent function is stable (useCallback) and safe to pass
 * as an event prop without causing re-renders.
 */

import { useCallback } from 'react';
import { useOperatorStore } from '../store/scada/operatorStore';
import { useTagWrite } from './useTagWrite';
import { useDataProvider } from '../providers';
import { useClientScript } from './useClientScript';
import type {
  WidgetEventBinding,
  WidgetEventTrigger,
  WidgetEventParams,
} from '../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface WidgetEventsResult {
  handleEvent: (trigger: WidgetEventTrigger, event?: React.MouseEvent) => void;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useWidgetEvents(
  events: WidgetEventBinding[] | undefined,
  onNavigate?: (screenId: string) => void,
): WidgetEventsResult {
  const openOverlay    = useOperatorStore((s) => s.openOverlay);
  const closeAllOverlays = useOperatorStore((s) => s.closeAllOverlays);
  const { writeTag, toggleTag } = useTagWrite();
  const provider                = useDataProvider();
  const { runScript }           = useClientScript();

  // -----------------------------------------------------------------------
  // Per-action dispatcher
  // -----------------------------------------------------------------------

  const dispatchAction = useCallback(
    async (params: WidgetEventParams, _event?: React.MouseEvent): Promise<void> => {
      switch (params.type) {
        case 'navigate': {
          onNavigate?.(params.screenId);
          break;
        }

        case 'openDialog': {
          openOverlay({
            type: 'dialog',
            screenId: params.screenId,
            position: { x: 0, y: 0 },
          });
          break;
        }

        case 'openCard': {
          openOverlay({
            type: 'card',
            screenId: params.screenId,
            position: { x: params.x ?? 0, y: params.y ?? 0 },
          });
          break;
        }

        case 'openTab': {
          window.open(params.url, '_blank', 'noopener,noreferrer');
          break;
        }

        case 'setValue': {
          try {
            await writeTag(params.tagId, params.value);
          } catch {
            // Errors are surfaced via useTagWrite.lastError; swallow here so
            // the event handler does not throw into the React event loop.
          }
          break;
        }

        case 'toggleValue': {
          try {
            if (params.bitmask !== undefined && params.bitmask !== 0) {
              // XOR-toggle: read current value, XOR with bitmask, write back.
              const currentVal = Number(provider.getTagValue(params.tagId)?.value ?? 0);
              const toggled = currentVal ^ params.bitmask;
              await writeTag(params.tagId, toggled);
            } else {
              await toggleTag(params.tagId);
            }
          } catch {
            // Errors are surfaced via useTagWrite.lastError; swallow here.
          }
          break;
        }

        case 'runScript': {
          // Resolve the script definition.  The SCADA editor packages scripts
          // into the project store; operator mode loads them from there.
          // We do a best-effort lookup via the window-global registry that the
          // SCADA runtime is expected to populate.  If not found we log and skip.
          const registry = (window as Window & { __scadaScripts__?: Record<string, import('../types/scada-runtime.types').ScadaScript> }).__scadaScripts__;
          const script = registry?.[params.scriptId];

          if (!script) {
            console.warn(
              `[useWidgetEvents] Script "${params.scriptId}" not found in __scadaScripts__ registry.`,
            );
            break;
          }

          try {
            await runScript(script, params.params);
          } catch {
            // runScript already captures the error internally.
          }
          break;
        }

        case 'close': {
          closeAllOverlays();
          break;
        }

        default:
          break;
      }
    },
    [onNavigate, openOverlay, closeAllOverlays, writeTag, toggleTag, provider, runScript],
  );

  // -----------------------------------------------------------------------
  // Event entry point
  // -----------------------------------------------------------------------

  const handleEvent = useCallback(
    (trigger: WidgetEventTrigger, event?: React.MouseEvent): void => {
      if (!events || events.length === 0) return;

      // Find all bindings that match this trigger.
      const matching = events.filter((b) => b.trigger === trigger);
      if (matching.length === 0) return;

      for (const binding of matching) {
        // Fire-and-forget; errors are handled internally per action type.
        void dispatchAction(binding.params, event);
      }
    },
    [events, dispatchAction],
  );

  return { handleEvent };
}
