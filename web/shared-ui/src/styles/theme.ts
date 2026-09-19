/**
 * Shared UI - Tema Konfigürasyonu
 * Aquaculture Platform için tutarlı tasarım sistemi
 */

// ============================================================================
// Renk Paleti — theme.css'in TypeScript aynası
// ============================================================================

/**
 * WHY a TypeScript mirror of theme.css: every `bg-primary-*` / `text-error-*`
 * utility resolves from the `@theme` block, but a CSS class cannot reach a
 * chart stroke, an SVG fill, a canvas or a default role colour. Those read
 * this object instead of writing raw hex, and
 * `tests/invariants/web-theme-token-parity.spec.ts` fails the build when the
 * two drift, so "using the tokens" can never mean using a second palette.
 *
 * WHY the values live in `@aquaculture/shared-contracts`: a NestJS service
 * cannot import a browser module, so the three HTML e-mail builders each grew
 * a private palette — the brand blue was `#0066cc` in one and `#3B82F6` in
 * another (FE-MEDIUM-093). The mirror moved to that zero-dependency lib; both
 * stacks now read the same bytes and this module re-exports them, so every
 * `import { colors } from '../styles/theme'` keeps working.
 */
import { colors } from '@aquaculture/shared-contracts';

export { colors };
export type { ColorTokens } from '@aquaculture/shared-contracts';

export { chartPalette, chartChrome } from '@aquaculture/shared-contracts';

// ============================================================================
// Tipografi
// ============================================================================

export const typography = {
  fontFamily: {
    sans: 'Inter, system-ui, -apple-system, sans-serif',
    mono: "'Geist Mono', ui-monospace, Consolas, monospace",
    display: "'Instrument Serif', ui-serif, Georgia, serif",
  },

  fontSize: {
    xs: '0.75rem', // 12px
    sm: '0.875rem', // 14px
    base: '1rem', // 16px
    lg: '1.125rem', // 18px
    xl: '1.25rem', // 20px
    '2xl': '1.5rem', // 24px
    '3xl': '1.875rem', // 30px
    '4xl': '2.25rem', // 36px
    '5xl': '3rem', // 48px
  },

  fontWeight: {
    thin: 100,
    light: 300,
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },

  lineHeight: {
    none: 1,
    tight: 1.25,
    snug: 1.375,
    normal: 1.5,
    relaxed: 1.625,
    loose: 2,
  },

  letterSpacing: {
    tighter: '-0.05em',
    tight: '-0.025em',
    normal: '0em',
    wide: '0.025em',
    wider: '0.05em',
    widest: '0.1em',
  },
} as const;

// ============================================================================
// Aralıklar (Spacing)
// ============================================================================

export const spacing = {
  0: '0',
  0.5: '0.125rem', // 2px
  1: '0.25rem', // 4px
  1.5: '0.375rem', // 6px
  2: '0.5rem', // 8px
  2.5: '0.625rem', // 10px
  3: '0.75rem', // 12px
  3.5: '0.875rem', // 14px
  4: '1rem', // 16px
  5: '1.25rem', // 20px
  6: '1.5rem', // 24px
  7: '1.75rem', // 28px
  8: '2rem', // 32px
  9: '2.25rem', // 36px
  10: '2.5rem', // 40px
  11: '2.75rem', // 44px
  12: '3rem', // 48px
  14: '3.5rem', // 56px
  16: '4rem', // 64px
  20: '5rem', // 80px
  24: '6rem', // 96px
  28: '7rem', // 112px
  32: '8rem', // 128px
} as const;

// ============================================================================
// Kenar Yuvarlaklığı (Border Radius)
// ============================================================================

export const borderRadius = {
  none: '0',
  sm: '0.125rem', // 2px
  DEFAULT: '0.25rem', // 4px
  md: '0.375rem', // 6px
  lg: '0.5rem', // 8px
  xl: '0.75rem', // 12px
  '2xl': '1rem', // 16px
  '3xl': '1.5rem', // 24px
  full: '9999px',
} as const;

// ============================================================================
// Gölgeler (Shadows)
// ============================================================================

export const shadows = {
  none: 'none',
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
} as const;

// ============================================================================
// Geçişler (Transitions)
// ============================================================================

export const transitions = {
  duration: {
    fast: '150ms',
    normal: '200ms',
    slow: '300ms',
    slower: '500ms',
  },
  timing: {
    ease: 'ease',
    easeIn: 'ease-in',
    easeOut: 'ease-out',
    easeInOut: 'ease-in-out',
    linear: 'linear',
  },
} as const;

// ============================================================================
// Z-Index Katmanları
// ============================================================================

export const zIndex = {
  hide: -1,
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  fixed: 1200,
  overlay: 1300,
  modal: 1400,
  popover: 1500,
  toast: 1600,
  tooltip: 1700,
} as const;

// ============================================================================
// Breakpoints (Duyarlı Tasarım)
// ============================================================================

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

// ============================================================================
// Tema Objesi
// ============================================================================

export const theme = {
  colors,
  typography,
  spacing,
  borderRadius,
  shadows,
  transitions,
  zIndex,
  breakpoints,
} as const;

export type Theme = typeof theme;

export default theme;
