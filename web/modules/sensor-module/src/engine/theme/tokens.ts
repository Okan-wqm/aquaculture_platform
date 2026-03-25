import type { ThemeTokens } from './types';

export const LIGHT_TOKENS: ThemeTokens = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f9fafb',
  bgTertiary: '#f3f4f6',
  bgCanvas: '#f8fafc',
  bgOverlay: 'rgba(0,0,0,0.4)',

  textPrimary: '#1f2937',
  textSecondary: '#4b5563',
  textMuted: '#9ca3af',
  textInverse: '#ffffff',

  borderDefault: '#e5e7eb',
  borderHover: '#d1d5db',
  borderActive: '#06b6d4',

  accentPrimary: '#06b6d4',
  accentLight: '#ecfeff',
  accentDark: '#0e7490',

  statusSuccess: '#22c55e',
  statusWarning: '#eab308',
  statusError: '#ef4444',
  statusInfo: '#3b82f6',

  shadowSm: '0 1px 2px rgba(0,0,0,0.05)',
  shadowMd: '0 4px 6px rgba(0,0,0,0.1)',
  shadowLg: '0 20px 60px rgba(0,0,0,0.15)',

  widgetBg: '#ffffff',
  widgetBorder: '#e5e7eb',
  widgetHeaderBg: '#f9fafb',
};

export const DARK_TOKENS: ThemeTokens = {
  bgPrimary: '#111827',
  bgSecondary: '#1f2937',
  bgTertiary: '#374151',
  bgCanvas: '#0f172a',
  bgOverlay: 'rgba(0,0,0,0.6)',

  textPrimary: '#f9fafb',
  textSecondary: '#d1d5db',
  textMuted: '#6b7280',
  textInverse: '#111827',

  borderDefault: '#374151',
  borderHover: '#4b5563',
  borderActive: '#22d3ee',

  accentPrimary: '#22d3ee',
  accentLight: '#164e63',
  accentDark: '#06b6d4',

  statusSuccess: '#4ade80',
  statusWarning: '#facc15',
  statusError: '#f87171',
  statusInfo: '#60a5fa',

  shadowSm: '0 1px 2px rgba(0,0,0,0.3)',
  shadowMd: '0 4px 6px rgba(0,0,0,0.4)',
  shadowLg: '0 20px 60px rgba(0,0,0,0.5)',

  widgetBg: '#1f2937',
  widgetBorder: '#374151',
  widgetHeaderBg: '#111827',
};
