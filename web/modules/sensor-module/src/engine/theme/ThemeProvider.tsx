import React, { createContext, useState, useCallback, useEffect, useMemo } from 'react';
import { getTenantId, tenantScopedStorageKey } from '@aquaculture/shared-ui';
import type { ThemeMode, ThemeTokens } from './types';
import { LIGHT_TOKENS, DARK_TOKENS } from './tokens';

export interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark';
  tokens: ThemeTokens;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Multi-tenant izolasyon: her tenant kendi tema tercihini saklar
 * Ayni browser'da farkli tenant'lar arasi veri sizintisini onler
 * Security: tenant-scoped localStorage key prevents cross-tenant data leakage
 * when multiple tenants are accessed from the same browser session
 */
// Returns null when no tenant is resolved so the theme degrades to the in-memory
// default instead of persisting into a shared 'default' bucket (cross-tenant bleed).
function getStorageKey(): string | null {
  return tenantScopedStorageKey('scada-theme-mode', getTenantId());
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function getSystemPreference(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const key = getStorageKey();
    if (!key) return 'light';
    return (localStorage.getItem(key) as ThemeMode) || 'light';
  });

  const resolvedMode = mode === 'system' ? getSystemPreference() : mode;
  const tokens = resolvedMode === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;

  // Listen for system theme changes
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setModeState('system'); // force re-render
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  // Apply CSS variables to document root
  useEffect(() => {
    const root = document.documentElement;
    const tokenEntries = Object.entries(tokens) as Array<[string, string]>;
    for (const [key, value] of tokenEntries) {
      root.style.setProperty(`--scada-${camelToKebab(key)}`, value);
    }
    root.setAttribute('data-scada-theme', resolvedMode);
  }, [tokens, resolvedMode]);

  // Persist to tenant-scoped localStorage
  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    const key = getStorageKey();
    if (key) localStorage.setItem(key, m);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolvedMode === 'light' ? 'dark' : 'light');
  }, [resolvedMode, setMode]);

  const value = useMemo(
    () => ({ mode, resolvedMode, tokens, setMode, toggle }),
    [mode, resolvedMode, tokens, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
