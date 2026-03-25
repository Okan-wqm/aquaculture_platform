/**
 * usePanelCollapse — Manages collapsed/expanded state for left and right panels.
 * Persists to localStorage so user preference survives page reloads.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

const STORAGE_KEY = 'scada-panel-collapse';

interface PanelState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface PanelCollapseState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBoth: () => void;
  expandLeft: () => void;
  expandRight: () => void;
  collapseLeft: () => void;
  collapseRight: () => void;
}

function loadPersistedState(): PanelState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'leftCollapsed' in parsed &&
        'rightCollapsed' in parsed
      ) {
        const state = parsed as PanelState;
        return {
          leftCollapsed: Boolean(state.leftCollapsed),
          rightCollapsed: Boolean(state.rightCollapsed),
        };
      }
    }
  } catch {
    // Ignore parse errors — fall through to default
  }
  return { leftCollapsed: false, rightCollapsed: false };
}

function persistState(state: PanelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore write errors (quota exceeded, etc.)
  }
}

export function usePanelCollapse(): PanelCollapseState {
  const [state, setState] = useState<PanelState>(loadPersistedState);

  // Track previous expanded state for toggleBoth restore
  const prevExpandedRef = useRef<PanelState>({
    leftCollapsed: false,
    rightCollapsed: false,
  });

  // Persist whenever state changes
  useEffect(() => {
    persistState(state);
  }, [state]);

  const toggleLeft = useCallback(() => {
    setState((prev) => ({ ...prev, leftCollapsed: !prev.leftCollapsed }));
  }, []);

  const toggleRight = useCallback(() => {
    setState((prev) => ({ ...prev, rightCollapsed: !prev.rightCollapsed }));
  }, []);

  const toggleBoth = useCallback(() => {
    setState((prev) => {
      const bothCollapsed = prev.leftCollapsed && prev.rightCollapsed;
      if (bothCollapsed) {
        // Restore to previous expanded state (default: both expanded)
        return { ...prevExpandedRef.current };
      }
      // Save current state before collapsing
      prevExpandedRef.current = { ...prev };
      return { leftCollapsed: true, rightCollapsed: true };
    });
  }, []);

  const expandLeft = useCallback(() => {
    setState((prev) => ({ ...prev, leftCollapsed: false }));
  }, []);

  const expandRight = useCallback(() => {
    setState((prev) => ({ ...prev, rightCollapsed: false }));
  }, []);

  const collapseLeft = useCallback(() => {
    setState((prev) => ({ ...prev, leftCollapsed: true }));
  }, []);

  const collapseRight = useCallback(() => {
    setState((prev) => ({ ...prev, rightCollapsed: true }));
  }, []);

  return {
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    toggleLeft,
    toggleRight,
    toggleBoth,
    expandLeft,
    expandRight,
    collapseLeft,
    collapseRight,
  };
}
