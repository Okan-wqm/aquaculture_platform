import type { ThemeTokens } from './types';
import { colors } from '@aquaculture/shared-ui';

export const LIGHT_TOKENS: ThemeTokens = {
  bgPrimary: colors.white,
  bgSecondary: colors.neutral[50],
  bgTertiary: colors.neutral[100],
  bgCanvas: colors.neutral[50],
  bgOverlay: 'rgba(0,0,0,0.4)',

  textPrimary: colors.neutral[800],
  textSecondary: colors.neutral[600],
  textMuted: colors.neutral[400],
  textInverse: colors.white,

  borderDefault: colors.neutral[200],
  borderHover: colors.neutral[300],
  borderActive: colors.primary[400],

  accentPrimary: colors.primary[400],
  accentLight: colors.primary[50],
  accentDark: colors.primary[600],

  statusSuccess: colors.success[500],
  statusWarning: colors.warning[500],
  statusError: colors.error[500],
  statusInfo: colors.info[500],

  shadowSm: '0 1px 2px rgba(0,0,0,0.05)',
  shadowMd: '0 4px 6px rgba(0,0,0,0.1)',
  shadowLg: '0 20px 60px rgba(0,0,0,0.15)',

  widgetBg: colors.white,
  widgetBorder: colors.neutral[200],
  widgetHeaderBg: colors.neutral[50],
};

export const DARK_TOKENS: ThemeTokens = {
  bgPrimary: colors.neutral[900],
  bgSecondary: colors.neutral[800],
  bgTertiary: colors.neutral[700],
  bgCanvas: colors.neutral[900],
  bgOverlay: 'rgba(0,0,0,0.6)',

  textPrimary: colors.neutral[50],
  textSecondary: colors.neutral[300],
  textMuted: colors.gray[400],
  textInverse: colors.neutral[900],

  borderDefault: colors.neutral[700],
  borderHover: colors.neutral[600],
  borderActive: colors.primary[300],

  accentPrimary: colors.primary[300],
  accentLight: colors.primary[800],
  accentDark: colors.primary[400],

  statusSuccess: colors.success[500],
  statusWarning: colors.warning[500],
  statusError: colors.error[500],
  statusInfo: colors.info[500],

  shadowSm: '0 1px 2px rgba(0,0,0,0.3)',
  shadowMd: '0 4px 6px rgba(0,0,0,0.4)',
  shadowLg: '0 20px 60px rgba(0,0,0,0.5)',

  widgetBg: colors.neutral[800],
  widgetBorder: colors.neutral[700],
  widgetHeaderBg: colors.neutral[900],
};
