/**
 * Shared UI - Tema Konfigürasyonu
 * Aquaculture Platform için tutarlı tasarım sistemi
 */

// ============================================================================
// Renk Paleti — theme.css'in TypeScript aynası
// ============================================================================

/**
 * WHY a TypeScript mirror: theme.css (`@theme`) is the single source of truth
 * for colour and every `bg-primary-*` / `text-error-*` utility resolves from
 * it — but CSS classes cannot reach chart strokes, SVG fills, canvas drawing
 * or a default role colour. Those places read this object instead of writing
 * raw hex. It carries exactly the tokens theme.css declares, in the same
 * scales and steps; `tests/invariants/web-theme-token-parity.spec.ts` fails
 * the build when the two drift, so "using the tokens" can never mean using a
 * second palette.
 */
type Scale10 = Readonly<Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>>;
type Scale5 = Readonly<Record<50 | 100 | 500 | 600 | 700, string>>;

export interface ColorTokens {
  readonly primary: Scale10;
  readonly secondary: Scale10;
  readonly accent: Scale10;
  readonly neutral: Scale10;
  readonly success: Scale5;
  readonly warning: Scale5;
  readonly error: Scale5;
  readonly info: Scale5;
  readonly gray: Readonly<Record<400, string>>;
  readonly white: string;
  readonly black: string;
  readonly transparent: string;
}

// WHY `string` values, not `as const` literals: a token used as a default
// parameter or a `useState` initial value would otherwise pin that field to
// ONE hex literal type and reject every other token.
export const colors: ColorTokens = {
  /** Primary — Ocean Blue */
  primary: {
    50: '#e6f3ff',
    100: '#b3d9ff',
    200: '#80bfff',
    300: '#4da6ff',
    400: '#1a8cff',
    500: '#0073e6',
    600: '#005bb3',
    700: '#004280',
    800: '#002a4d',
    900: '#00111a',
  },

  /** Secondary — Sea Green */
  secondary: {
    50: '#e6fff5',
    100: '#b3ffe0',
    200: '#80ffcc',
    300: '#4dffb8',
    400: '#1affa3',
    500: '#00e68a',
    600: '#00b36b',
    700: '#00804d',
    800: '#004d2e',
    900: '#001a10',
  },

  /** Accent — Coral */
  accent: {
    50: '#fff5f2',
    100: '#ffe0d9',
    200: '#ffccc0',
    300: '#ffb8a6',
    400: '#ffa38d',
    500: '#ff8f73',
    600: '#cc7259',
    700: '#995540',
    800: '#663926',
    900: '#331c13',
  },

  /** Neutral — slate */
  neutral: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },

  /** Semantic scales (50 / 100 / 500 / 600 / 700, as theme.css declares them) */
  success: {
    50: '#ecfdf5',
    100: '#d1fae5',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
  },
  warning: {
    50: '#fffbeb',
    100: '#fef3c7',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
  },
  error: {
    50: '#fef2f2',
    100: '#fee2e2',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
  },
  info: {
    50: '#eff6ff',
    100: '#dbeafe',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
  },

  /**
   * The one Tailwind default theme.css overrides: gray-400 darkened for WCAG
   * 2.1 AA text contrast (FE-MEDIUM-024). Also the axis/helper-text grey.
   */
  gray: {
    400: '#6b7280',
  },

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
};

/**
 * Ordered categorical palette for chart series (recharts, pies, gauges):
 * brand first, then the semantic accents, then the deep brand shades.
 */
export const chartPalette: readonly string[] = [
  colors.primary[500],
  colors.secondary[600],
  colors.accent[500],
  colors.warning[500],
  colors.info[600],
  colors.error[500],
  colors.primary[700],
  colors.accent[700],
];

/** Chart chrome shared by every chart: grid lines, axis strokes, tooltip borders. */
export const chartChrome: Readonly<{ grid: string; axis: string; border: string }> = {
  grid: colors.neutral[200],
  axis: colors.gray[400],
  border: colors.neutral[200],
};

// ============================================================================
// Tipografi
// ============================================================================

export const typography = {
  fontFamily: {
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  },

  fontSize: {
    xs: '0.75rem',     // 12px
    sm: '0.875rem',    // 14px
    base: '1rem',      // 16px
    lg: '1.125rem',    // 18px
    xl: '1.25rem',     // 20px
    '2xl': '1.5rem',   // 24px
    '3xl': '1.875rem', // 30px
    '4xl': '2.25rem',  // 36px
    '5xl': '3rem',     // 48px
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
  0.5: '0.125rem',  // 2px
  1: '0.25rem',     // 4px
  1.5: '0.375rem',  // 6px
  2: '0.5rem',      // 8px
  2.5: '0.625rem',  // 10px
  3: '0.75rem',     // 12px
  3.5: '0.875rem',  // 14px
  4: '1rem',        // 16px
  5: '1.25rem',     // 20px
  6: '1.5rem',      // 24px
  7: '1.75rem',     // 28px
  8: '2rem',        // 32px
  9: '2.25rem',     // 36px
  10: '2.5rem',     // 40px
  11: '2.75rem',    // 44px
  12: '3rem',       // 48px
  14: '3.5rem',     // 56px
  16: '4rem',       // 64px
  20: '5rem',       // 80px
  24: '6rem',       // 96px
  28: '7rem',       // 112px
  32: '8rem',       // 128px
} as const;

// ============================================================================
// Kenar Yuvarlaklığı (Border Radius)
// ============================================================================

export const borderRadius = {
  none: '0',
  sm: '0.125rem',   // 2px
  DEFAULT: '0.25rem', // 4px
  md: '0.375rem',   // 6px
  lg: '0.5rem',     // 8px
  xl: '0.75rem',    // 12px
  '2xl': '1rem',    // 16px
  '3xl': '1.5rem',  // 24px
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
