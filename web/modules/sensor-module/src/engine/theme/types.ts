export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeTokens {
  // Surface colors
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgCanvas: string;
  bgOverlay: string;

  // Text colors
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  // Border colors
  borderDefault: string;
  borderHover: string;
  borderActive: string;

  // Accent
  accentPrimary: string;
  accentLight: string;
  accentDark: string;

  // Status
  statusSuccess: string;
  statusWarning: string;
  statusError: string;
  statusInfo: string;

  // Shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  // Widget specific
  widgetBg: string;
  widgetBorder: string;
  widgetHeaderBg: string;
}
