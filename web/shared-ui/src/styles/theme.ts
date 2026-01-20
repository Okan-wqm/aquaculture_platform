/**
 * Shared UI - Tema Konfigürasyonu
 * Aquaculture Platform için tutarlı tasarım sistemi
 */

// ============================================================================
// Renk Paleti
// ============================================================================

export const colors = {
  // Marka renkleri
  brand: {
    50: '#e6f7ff',
    100: '#bae7ff',
    200: '#91d5ff',
    300: '#69c0ff',
    400: '#40a9ff',
    500: '#1890ff', // Ana marka rengi
    600: '#096dd9',
    700: '#0050b3',
    800: '#003a8c',
    900: '#002766',
  },

  // Gri tonları
  gray: {
    50: '#fafafa',
    100: '#f5f5f5',
    200: '#e8e8e8',
    300: '#d9d9d9',
    400: '#bfbfbf',
    500: '#8c8c8c',
    600: '#595959',
    700: '#434343',
    800: '#262626',
    900: '#1f1f1f',
  },

  // Yeşil - Başarı durumları
  green: {
    50: '#f6ffed',
    100: '#d9f7be',
    200: '#b7eb8f',
    300: '#95de64',
    400: '#73d13d',
    500: '#52c41a', // Başarı rengi
    600: '#389e0d',
    700: '#237804',
    800: '#135200',
    900: '#092b00',
  },

  // Kırmızı - Hata durumları
  red: {
    50: '#fff1f0',
    100: '#ffccc7',
    200: '#ffa39e',
    300: '#ff7875',
    400: '#ff4d4f',
    500: '#f5222d', // Hata rengi
    600: '#cf1322',
    700: '#a8071a',
    800: '#820014',
    900: '#5c0011',
  },

  // Sarı - Uyarı durumları
  yellow: {
    50: '#fffbe6',
    100: '#fff1b8',
    200: '#ffe58f',
    300: '#ffd666',
    400: '#ffc53d',
    500: '#faad14', // Uyarı rengi
    600: '#d48806',
    700: '#ad6800',
    800: '#874d00',
    900: '#613400',
  },

  // Mavi - Bilgi durumları
  blue: {
    50: '#e6f7ff',
    100: '#bae7ff',
    200: '#91d5ff',
    300: '#69c0ff',
    400: '#40a9ff',
    500: '#1890ff', // Bilgi rengi
    600: '#096dd9',
    700: '#0050b3',
    800: '#003a8c',
    900: '#002766',
  },

  // Turkuaz - Su teması için özel
  aqua: {
    50: '#e6fffb',
    100: '#b5f5ec',
    200: '#87e8de',
    300: '#5cdbd3',
    400: '#36cfc9',
    500: '#13c2c2', // Su rengi
    600: '#08979c',
    700: '#006d75',
    800: '#00474f',
    900: '#002329',
  },

  // Semantik renkler
  semantic: {
    success: '#52c41a',
    warning: '#faad14',
    error: '#f5222d',
    info: '#1890ff',
  },

  // Temel renkler
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

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

// ============================================================================
// Karanlık Tema Renkleri
// ============================================================================

export const darkColors = {
  ...colors,
  // Karanlık tema için ters çevrilmiş gri tonları
  gray: {
    50: '#1f1f1f',
    100: '#262626',
    200: '#434343',
    300: '#595959',
    400: '#8c8c8c',
    500: '#bfbfbf',
    600: '#d9d9d9',
    700: '#e8e8e8',
    800: '#f5f5f5',
    900: '#fafafa',
  },
} as const;

// ============================================================================
// CSS Değişkenleri Üreteci
// ============================================================================

export function generateCSSVariables(isDark = false): string {
  const colorSet = isDark ? darkColors : colors;

  const cssVars: string[] = [];

  // Renkleri CSS değişkenlerine dönüştür
  Object.entries(colorSet).forEach(([colorName, colorValues]) => {
    if (typeof colorValues === 'string') {
      cssVars.push(`--color-${colorName}: ${colorValues}`);
    } else {
      Object.entries(colorValues).forEach(([shade, value]) => {
        cssVars.push(`--color-${colorName}-${shade}: ${value}`);
      });
    }
  });

  return cssVars.join(';\n');
}

export default theme;
